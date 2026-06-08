//! AST whitespace-equivalence for Rust source via tree-sitter.
//!
//! Ports `astEqual` / `tokenize` / `collectLeafTokens` from the TypeScript
//! merge engine (`sharp/apps/client/src/merge/index.ts`). Two source strings
//! are "AST-equal" when their canonical token streams (everything that is not
//! a run of whitespace between tokens) are byte-identical.
//!
//! Why parse instead of just regex-stripping whitespace? Because a `\s+`
//! strip would also eat whitespace *inside* string literals — which would
//! falsely declare `"hello"` and `"h ello"` equivalent. The tree-sitter parse
//! keeps string content as a single atomic token whose text includes its
//! internal whitespace.
//!
//! Comments and string literals are part of the token stream (they are
//! [`ATOMIC_NODE_TYPES`]) so comment-only or string-only changes are NOT
//! considered whitespace-equivalent — they are real semantic edits.
//!
//! Scope: this Rust crate is Rust-only (the TypeScript semantic path is
//! handled out-of-process by [`crate::semantic_merge_ts`] via the
//! tsserver-bridge). Tree-sitter-typescript is therefore intentionally not a
//! dependency; [`ast_equal`] operates on Rust source.
//!
//! §architecture.md — Sharp subsystem (Tier-1 AST whitespace-equivalence)

use crate::error::SharpError;
use tree_sitter::{Node, Parser};

/// Node types whose text content is not fully reconstructible from their child
/// tokens — tree-sitter's Rust grammar represents `string_literal`,
/// `char_literal`, comments, etc. with delimiter tokens as children but keeps
/// the actual content only on the parent. For these we record the parent's
/// full text and do not recurse; comparisons then catch content changes inside
/// string literals and comments.
///
/// Includes the TypeScript node names from the original `ATOMIC_NODE_TYPES`
/// set as well, harmless for a Rust parse but kept for fidelity with the TS
/// source should a TS grammar be wired in later.
pub const ATOMIC_NODE_TYPES: &[&str] = &[
    // Rust
    "string_literal",
    "raw_string_literal",
    "char_literal",
    "byte_string_literal",
    "byte_literal",
    "integer_literal",
    "float_literal",
    "line_comment",
    "block_comment",
    // TypeScript
    "string",
    "template_string",
    "regex",
    "number",
    "comment",
    "string_fragment",
    "template_substitution",
];

fn is_atomic(kind: &str) -> bool {
    ATOMIC_NODE_TYPES.contains(&kind)
}

/// Whitespace-collapsed AST equality for two Rust source strings.
///
/// Returns `true` when the canonical token streams are byte-identical, after
/// trailing-comma normalization (a `,` immediately preceding a closing
/// bracket is syntactically optional in Rust, so Prettier-style reformats that
/// add one are still recognized as equivalent).
pub fn ast_equal(x: &str, y: &str) -> Result<bool, SharpError> {
    if x == y {
        return Ok(true);
    }
    Ok(tokenize(x)? == tokenize(y)?)
}

/// Parse `src` as Rust and produce its canonical token stream, joined with a
/// NUL separator. Mirrors the TS `tokenize`.
pub fn tokenize(src: &str) -> Result<String, SharpError> {
    let mut parser = Parser::new();
    parser
        .set_language(&tree_sitter_rust::LANGUAGE.into())
        .map_err(|e| SharpError::Protocol(format!("tree-sitter set_language: {e}")))?;
    let tree = parser
        .parse(src, None)
        .ok_or_else(|| SharpError::Protocol("tree-sitter parse returned None".into()))?;

    let bytes = src.as_bytes();
    let mut tokens: Vec<String> = Vec::new();
    collect_leaf_tokens(tree.root_node(), bytes, &mut tokens);

    // Trailing-comma normalization: a `,` token immediately preceding a
    // closing bracket (`)`, `]`, `}`, `>`) is syntactically optional. Drop
    // these so a reformat-only diff that adds trailing commas is recognized as
    // whitespace-equivalent. A comma leaf is encoded as `,:,`.
    let kept: Vec<&String> = tokens
        .iter()
        .enumerate()
        .filter(|(i, t)| {
            if t.as_str() != ",:," {
                return true;
            }
            let Some(next) = tokens.get(i + 1) else {
                return true;
            };
            // Recover the *text* portion (after the first ':').
            let text = match next.find(':') {
                Some(idx) => &next[idx + 1..],
                None => next.as_str(),
            };
            !(text == ")" || text == "]" || text == "}" || text == ">")
        })
        .map(|(_, t)| t)
        .collect();

    Ok(kept
        .iter()
        .map(|s| s.as_str())
        .collect::<Vec<_>>()
        .join("\0"))
}

fn collect_leaf_tokens(node: Node, src: &[u8], out: &mut Vec<String>) {
    let kind = node.kind();
    if node.child_count() == 0 {
        let text = node.utf8_text(src).unwrap_or("");
        out.push(format!("{kind}:{text}"));
        return;
    }
    if is_atomic(kind) {
        let text = node.utf8_text(src).unwrap_or("");
        out.push(format!("{kind}:{text}"));
        return;
    }
    let count = node.child_count() as u32;
    for i in 0..count {
        if let Some(child) = node.child(i) {
            collect_leaf_tokens(child, src, out);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_source_is_equal() {
        assert!(ast_equal("fn main() {}", "fn main() {}").unwrap());
    }

    #[test]
    fn whitespace_reformat_is_equal() {
        let a = "fn main(){let x=1;}";
        let b = "fn main() {\n    let x = 1;\n}\n";
        assert!(ast_equal(a, b).unwrap());
    }

    #[test]
    fn semantic_change_is_not_equal() {
        let a = "fn main() { let x = 1; }";
        let b = "fn main() { let x = 2; }";
        assert!(!ast_equal(a, b).unwrap());
    }

    #[test]
    fn whitespace_inside_string_is_not_equal() {
        let a = r#"fn f() { let s = "hello"; }"#;
        let b = r#"fn f() { let s = "h ello"; }"#;
        assert!(!ast_equal(a, b).unwrap());
    }

    #[test]
    fn comment_change_is_not_equal() {
        let a = "fn f() {} // old";
        let b = "fn f() {} // new";
        assert!(!ast_equal(a, b).unwrap());
    }

    #[test]
    fn trailing_comma_normalized() {
        let a = "fn f() -> (i32, i32) { (1, 2) }";
        let b = "fn f() -> (i32, i32,) { (1, 2,) }";
        assert!(ast_equal(a, b).unwrap());
    }
}
