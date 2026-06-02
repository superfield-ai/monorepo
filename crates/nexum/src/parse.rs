//! Document parsing — split content into typed blocks.
//!
//! Mirrors the TypeScript `src/ingest/parse-text.ts` and
//! `src/ingest/parse-markdown.ts` in the Nexum Node service so that the
//! Rust pipeline produces the same block/link counts for the same fixture.

/// The type of content a block holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BlockType {
    Paragraph,
    Heading,
    ListItem,
}

impl BlockType {
    /// String representation stored in the `block_type` column.
    pub fn as_str(&self) -> &'static str {
        match self {
            BlockType::Paragraph => "paragraph",
            BlockType::Heading => "heading",
            BlockType::ListItem => "list_item",
        }
    }
}

/// A parsed content block.
#[derive(Debug, Clone)]
pub struct Block {
    pub block_type: BlockType,
    /// The text content of this block.
    pub content: String,
    /// Heading depth (`1`–`6`) for headings; `None` for other block types.
    pub level: Option<i32>,
}

/// The format of the source document.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Text,
    Markdown,
}

/// Parse `content` into an ordered list of [`Block`]s using the given [`Format`].
///
/// Semantics are kept exactly in sync with the TypeScript parsers so that
/// fixture-based parity tests can assert equal block counts.
pub fn parse_document(content: &str, format: Format) -> Vec<Block> {
    match format {
        Format::Text => parse_text(content),
        Format::Markdown => parse_markdown(content),
    }
}

// ── Text parser ───────────────────────────────────────────────────────────────

/// Split plain text into paragraph blocks on blank lines, mirroring
/// `parseText` in `src/ingest/parse-text.ts`.
fn parse_text(content: &str) -> Vec<Block> {
    content
        .split("\n\n")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(|s| Block {
            block_type: BlockType::Paragraph,
            content: s,
            level: None,
        })
        .collect()
}

// ── Markdown parser ───────────────────────────────────────────────────────────

/// Parse Markdown into typed blocks, mirroring `parseMarkdown` in
/// `src/ingest/parse-markdown.ts`.
///
/// Rules:
/// - `# … ######` → heading blocks with the appropriate depth.
/// - `- …` / `* …` lines → list_item blocks.
/// - Blank lines flush the current paragraph buffer.
/// - Non-empty non-special lines accumulate in the paragraph buffer.
fn parse_markdown(content: &str) -> Vec<Block> {
    let mut blocks: Vec<Block> = Vec::new();
    let mut buf = String::new();
    let mut buf_type = BlockType::Paragraph;
    let mut buf_level: Option<i32> = None;

    let flush = |blocks: &mut Vec<Block>, buf: &mut String, bt: &BlockType, level: Option<i32>| {
        let text = buf.trim().to_string();
        if !text.is_empty() {
            blocks.push(Block {
                block_type: bt.clone(),
                content: text,
                level,
            });
        }
        buf.clear();
    };

    for line in content.lines() {
        // Heading?
        if let Some(rest) = line.strip_prefix('#') {
            // Count the leading '#' characters (including the first one).
            let mut hashes = 1usize;
            let mut chars = rest.chars();
            for c in &mut chars {
                if c == '#' {
                    hashes += 1;
                } else {
                    break;
                }
            }
            let text = rest.trim_start_matches('#').trim().to_string();
            if !text.is_empty() || hashes > 0 {
                flush(&mut blocks, &mut buf, &buf_type, buf_level);
                buf_type = BlockType::Paragraph;
                buf_level = None;
                if !text.is_empty() {
                    blocks.push(Block {
                        block_type: BlockType::Heading,
                        content: text,
                        level: Some(hashes as i32),
                    });
                }
                continue;
            }
        }

        // List item?
        if let Some(rest) = line.strip_prefix("- ").or_else(|| line.strip_prefix("* ")) {
            flush(&mut blocks, &mut buf, &buf_type, buf_level);
            buf_type = BlockType::Paragraph;
            buf_level = None;
            let text = rest.trim().to_string();
            if !text.is_empty() {
                blocks.push(Block {
                    block_type: BlockType::ListItem,
                    content: text,
                    level: None,
                });
            }
            continue;
        }

        // Blank line?
        if line.trim().is_empty() {
            flush(&mut blocks, &mut buf, &buf_type, buf_level);
            buf_type = BlockType::Paragraph;
            buf_level = None;
            continue;
        }

        // Accumulate paragraph.
        if buf.is_empty() {
            buf.push_str(line);
        } else {
            buf.push('\n');
            buf.push_str(line);
        }
    }

    flush(&mut blocks, &mut buf, &buf_type, buf_level);
    blocks
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_text_splits_on_blank_lines() {
        let input = "First paragraph.\n\nSecond paragraph.\n\nThird.";
        let blocks = parse_document(input, Format::Text);
        assert_eq!(blocks.len(), 3);
        assert!(blocks.iter().all(|b| b.block_type == BlockType::Paragraph));
    }

    #[test]
    fn parse_text_trims_and_ignores_empty_segments() {
        let input = "\n\n   \n\nHello.\n\n\n\nWorld.\n\n";
        let blocks = parse_document(input, Format::Text);
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].content, "Hello.");
        assert_eq!(blocks[1].content, "World.");
    }

    #[test]
    fn parse_markdown_headings() {
        let input = "# Title\n\n## Section\n\nParagraph text.";
        let blocks = parse_document(input, Format::Markdown);
        let headings: Vec<_> = blocks
            .iter()
            .filter(|b| b.block_type == BlockType::Heading)
            .collect();
        assert_eq!(headings.len(), 2);
        assert_eq!(headings[0].level, Some(1));
        assert_eq!(headings[0].content, "Title");
        assert_eq!(headings[1].level, Some(2));
    }

    #[test]
    fn parse_markdown_list_items() {
        let input = "- item one\n- item two\n* item three";
        let blocks = parse_document(input, Format::Markdown);
        let items: Vec<_> = blocks
            .iter()
            .filter(|b| b.block_type == BlockType::ListItem)
            .collect();
        assert_eq!(items.len(), 3);
        assert_eq!(items[0].content, "item one");
    }

    #[test]
    fn parse_markdown_paragraph_accumulates_lines() {
        let input = "Line one\nLine two\nLine three\n\nAnother paragraph.";
        let blocks = parse_document(input, Format::Markdown);
        assert_eq!(blocks.len(), 2);
        assert!(blocks[0].content.contains("Line one"));
        assert!(blocks[0].content.contains("Line two"));
    }
}
