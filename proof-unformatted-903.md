# Throwaway prettier regression proof (issue #903)

This file exists   solely   to   prove   that   prettier   flags   unformatted
markdown and that a markdown-only PR is covered by the CI prettier check.

## Intentional violations

-  Extra space after the bullet marker.
   -  Nested bullet with a tab-like indentation that prettier would normalise.
   *  A different bullet marker on purpose.

1. Ordered list start.
2. This line is deliberately way too long and should be wrapped by prettier onto multiple lines because it exceeds the configured print width of eighty characters by a substantial margin without question.
3.   Extra space after the list marker here as well.

Some inline text with   multiple   consecutive   spaces   that prettier will collapse.

## Checklist

- [ ] This PR must never be merged
- [x] Prettier should report an error on this file