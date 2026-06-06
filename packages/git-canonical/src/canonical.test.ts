import { describe, expect, it } from 'vitest';
import {
  decodeCommit,
  decodeTag,
  decodeTree,
  encodeCommit,
  encodeTag,
  encodeTree,
  hashObject,
  idHex,
  idFromHex,
  type CommitObject,
  type TreeEntry,
} from './index';

const PINNED_PERSON = {
  nameAndEmail: 'Alice Doe <alice@example.com>',
  timestamp: 1735689600,
  timezone: '+0000',
};

describe('hashObject', () => {
  it('matches the well-known empty tree SHA-1', () => {
    const id = hashObject('tree', new Uint8Array(0), 'sha1');
    expect(idHex(id)).toBe('4b825dc642cb6eb9a060e54bf8d69288fbee4904');
  });

  it('matches the well-known empty blob SHA-1', () => {
    const id = hashObject('blob', new Uint8Array(0), 'sha1');
    expect(idHex(id)).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  });

  it('hashes "what is up, doc?" to the well-known SHA-1 blob hash', () => {
    // git hash-object --stdin <<< "what is up, doc?"
    // (note: shell adds a trailing newline)
    const payload = new Uint8Array(Buffer.from('what is up, doc?', 'utf8'));
    const id = hashObject('blob', payload, 'sha1');
    expect(idHex(id)).toBe('bd9dbf5aae1a3862dd1526723246b20206e5fc37');
  });

  it('matches a known empty tree SHA-256 hash', () => {
    // git hash-object --object-format=sha256 -t tree --stdin < /dev/null
    const id = hashObject('tree', new Uint8Array(0), 'sha256');
    expect(idHex(id)).toBe('6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321');
  });
});

describe('encodeTree / decodeTree', () => {
  function blob(name: string): TreeEntry {
    return {
      mode: '100644',
      name,
      id: hashObject('blob', new Uint8Array(0), 'sha1'),
    };
  }
  function dir(name: string): TreeEntry {
    return {
      mode: '40000',
      name,
      id: hashObject('tree', new Uint8Array(0), 'sha1'),
    };
  }

  it('roundtrips a single entry', () => {
    const entries = [blob('README.md')];
    const bytes = encodeTree(entries);
    const decoded = decodeTree(bytes);
    expect(decoded).toHaveLength(1);
    expect(decoded[0]?.name).toBe('README.md');
    expect(decoded[0]?.mode).toBe('100644');
  });

  it('honors the directory-sort quirk: foo (dir) sorts after foo.txt (file)', () => {
    // Without the quirk, a bytewise sort would put `foo` (0x66 0x6f 0x6f)
    // before `foo.txt` because `foo` is a prefix. With the quirk,
    // `foo/` (0x66 0x6f 0x6f 0x2f) sorts after `foo.txt` (0x66 0x6f 0x6f 0x2e ...)
    // because 0x2f > 0x2e.
    const entries = [dir('foo'), blob('foo.txt')];
    const bytes = encodeTree(entries);
    const decoded = decodeTree(bytes);
    expect(decoded.map((e) => e.name)).toEqual(['foo.txt', 'foo']);
  });

  it('hashes a tree containing one file to the same SHA-1 stock git produces', () => {
    const entries = [blob('hello.txt')];
    const treeBytes = encodeTree(entries);
    const id = hashObject('tree', treeBytes, 'sha1');
    // Verified against stock git:
    //   git init && touch hello.txt && git add hello.txt && git write-tree
    expect(idHex(id)).toBe('fcb545d5746547a597811b7441ed8eba307be1ff');
  });

  it('supports submodule gitlinks (mode 160000)', () => {
    const entries: TreeEntry[] = [
      { mode: '160000', name: 'vendor', id: idFromHex('aa'.repeat(20)) },
    ];
    const bytes = encodeTree(entries);
    const decoded = decodeTree(bytes);
    expect(decoded[0]?.mode).toBe('160000');
    expect(idHex(decoded[0]!.id)).toBe('aa'.repeat(20));
  });

  it('refuses entry names containing slash or null', () => {
    expect(() =>
      encodeTree([{ mode: '100644', name: 'a/b', id: idFromHex('00'.repeat(20)) }]),
    ).toThrow();
    expect(() =>
      encodeTree([{ mode: '100644', name: 'a\0b', id: idFromHex('00'.repeat(20)) }]),
    ).toThrow();
  });
});

describe('encodeCommit / decodeCommit', () => {
  const TREE = idFromHex('4b825dc642cb6eb9a060e54bf8d69288fbee4904'); // empty tree
  const PARENT = idFromHex('aa'.repeat(20));

  it('roundtrips a no-parent commit', () => {
    const c: CommitObject = {
      tree: TREE,
      parents: [],
      author: PINNED_PERSON,
      committer: PINNED_PERSON,
      message: 'initial commit\n',
    };
    const bytes = encodeCommit(c);
    const decoded = decodeCommit(bytes);
    expect(decoded.tree).toEqual(TREE);
    expect(decoded.parents).toEqual([]);
    expect(decoded.message).toBe('initial commit\n');
    expect(decoded.author.nameAndEmail).toBe(PINNED_PERSON.nameAndEmail);
    expect(decoded.author.timestamp).toBe(PINNED_PERSON.timestamp);
  });

  it('roundtrips a multi-parent (merge) commit', () => {
    const c: CommitObject = {
      tree: TREE,
      parents: [PARENT, idFromHex('bb'.repeat(20))],
      author: PINNED_PERSON,
      committer: PINNED_PERSON,
      message: 'merge\n',
    };
    const bytes = encodeCommit(c);
    const decoded = decodeCommit(bytes);
    expect(decoded.parents).toHaveLength(2);
    expect(idHex(decoded.parents[0]!)).toBe('aa'.repeat(20));
    expect(idHex(decoded.parents[1]!)).toBe('bb'.repeat(20));
  });

  it('preserves a gpgsig extra header through encode/decode', () => {
    const sig = '-----BEGIN PGP SIGNATURE-----\n…sig…\n-----END PGP SIGNATURE-----';
    const c: CommitObject = {
      tree: TREE,
      parents: [],
      author: PINNED_PERSON,
      committer: PINNED_PERSON,
      extraHeaders: [{ name: 'gpgsig', value: sig }],
      message: 'signed commit\n',
    };
    const bytes = encodeCommit(c);
    const decoded = decodeCommit(bytes);
    const sigHeader = decoded.extraHeaders!.find((h) => h.name === 'gpgsig');
    expect(sigHeader?.value).toBe(sig);
  });

  it('preserves a non-UTF-8 encoding header', () => {
    const c: CommitObject = {
      tree: TREE,
      parents: [],
      author: PINNED_PERSON,
      committer: PINNED_PERSON,
      extraHeaders: [{ name: 'encoding', value: 'iso-8859-1' }],
      message: 'message\n',
    };
    const bytes = encodeCommit(c);
    const decoded = decodeCommit(bytes);
    expect(decoded.extraHeaders).toContainEqual({ name: 'encoding', value: 'iso-8859-1' });
  });
});

describe('encodeTag / decodeTag', () => {
  it('roundtrips a signed annotated tag (well-formed)', () => {
    const target = idFromHex('11'.repeat(20));
    const t = {
      object: target,
      type: 'commit' as const,
      tag: 'v1.0.0',
      tagger: PINNED_PERSON,
      message: 'release notes\n',
    };
    const bytes = encodeTag(t);
    const decoded = decodeTag(bytes);
    expect(decoded.tag).toBe('v1.0.0');
    expect(decoded.type).toBe('commit');
    expect(idHex(decoded.object)).toBe('11'.repeat(20));
  });
});
