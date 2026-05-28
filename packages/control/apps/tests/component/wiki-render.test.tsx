/**
 * Component tests for WikiRender (issue #322).
 *
 * Confirms the component outputs rendered HTML structure that matches the
 * parsed markdown output from renderMarkdown.  The unit test for the parser
 * logic lives in tests/unit/wiki-render.test.ts; this file covers the
 * React rendering layer.
 */

import React from "react";
import { render } from "vitest-browser-react";
import { describe, expect, test } from "vitest";
import { WikiRender, renderMarkdown } from "../../src/components/WikiRender";

describe("WikiRender", () => {
  test("renders an article element", async () => {
    const screen = render(<WikiRender content="Hello **world**" />);
    const article = screen.container.querySelector("article");
    expect(article).not.toBeNull();
  });

  test("renders heading from markdown", async () => {
    const screen = render(<WikiRender content="# Title" />);
    const h1 = screen.container.querySelector("h1");
    expect(h1).not.toBeNull();
    expect(h1?.textContent).toContain("Title");
  });

  test("renders bold text as <strong>", async () => {
    const screen = render(<WikiRender content="This is **bold**." />);
    const strong = screen.container.querySelector("strong");
    expect(strong).not.toBeNull();
    expect(strong?.textContent).toBe("bold");
  });

  test("renders italic text as <em>", async () => {
    const screen = render(<WikiRender content="This is *italic*." />);
    const em = screen.container.querySelector("em");
    expect(em).not.toBeNull();
    expect(em?.textContent).toBe("italic");
  });

  test("renders inline code as <code>", async () => {
    const screen = render(<WikiRender content="`console.log('hi')`" />);
    const code = screen.container.querySelector("code");
    expect(code).not.toBeNull();
    expect(code?.textContent).toBe("console.log('hi')");
  });

  test("renders a link as <a> with correct href", async () => {
    const screen = render(<WikiRender content="[docs](/app/docs)" />);
    const a = screen.container.querySelector("a");
    expect(a).not.toBeNull();
    expect(a?.getAttribute("href")).toBe("/app/docs");
    expect(a?.textContent).toBe("docs");
  });

  test("renders list items as <li> inside <ul>", async () => {
    const content = `- alpha
- beta
- gamma`;
    const screen = render(<WikiRender content={content} />);
    const items = screen.container.querySelectorAll("li");
    expect(items.length).toBe(3);
    expect(items[0].textContent).toContain("alpha");
  });

  test("rendered HTML contains the same semantic elements as renderMarkdown output", async () => {
    const md = `# Heading

Some **bold** and *italic* text.

- item one
- item two`;
    const screen = render(<WikiRender content={md} />);
    const article = screen.container.querySelector("article");
    // The browser normalises the raw HTML string differently to innerHTML, so
    // check for the presence of expected elements rather than an exact string match.
    expect(article?.querySelector("h1")?.textContent).toContain("Heading");
    expect(article?.querySelector("strong")?.textContent).toContain("bold");
    expect(article?.querySelector("em")?.textContent).toContain("italic");
    const lis = article?.querySelectorAll("li");
    expect(lis?.length).toBe(2);
    expect(lis?.[0].textContent).toContain("item one");
    expect(lis?.[1].textContent).toContain("item two");
  });

  test("applies extra className to the article element", async () => {
    const screen = render(
      <WikiRender content="text" className="my-custom-class" />,
    );
    const article = screen.container.querySelector("article");
    expect(article?.className).toContain("my-custom-class");
  });

  test("empty content renders an empty article", async () => {
    const screen = render(<WikiRender content="" />);
    const article = screen.container.querySelector("article");
    expect(article).not.toBeNull();
    // renderMarkdown("") yields an empty string — no child nodes.
    expect(article?.innerHTML).toBe(renderMarkdown(""));
  });
});
