import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  rehypeSourceAnchors,
  remarkSourceAnchors,
} from "../src/markdown-source.ts";

const cases = {
  "nested bullet lists":
    "- Outer\n  - Inner\n    > First\n    > Reading marker",
  "nested ordered lists":
    "1. Outer\n   1. Inner\n      > First\n      > Reading marker",
  "leading indentation on lists":
    "  - Outer\n    - Inner\n        > First\n        > Reading marker",
  "leading indentation on lists inside a quote":
    ">   - Outer\n>     - Inner\n>         > First\n>         > Reading marker",
  "lists inside a quote":
    "> - Outer\n>   - Inner\n>     > First\n>     > Reading marker",
  "tab-indented list continuation":
    "- Outer\n  - Inner\n\t> First\n\t> Reading marker",
  "code in a nested list quote":
    "- Outer\n  - Inner\n    > ```text\n    > First\n    > Reading marker\n    > ```",
  "literal marker in a lazy quote continuation":
    "> First\n    > Reading marker",
  "literal marker in a lazy list quote continuation":
    "- Outer\n  > First\n      > Reading marker",
  "literal marker in an indented nested list quote":
    "  - Outer\n    - Inner\n      > First\n          > Reading marker",
  "literal marker in quoted code":
    "- Outer\n  - Inner\n    > ```text\n    > First\n    > > Reading marker\n    > ```",
  "decreasing outer quote indentation":
    "   > Outer\n> - List\n>     > First\n>     > Reading marker",
  "changing outer quote spacing":
    "> Outer\n>\t- List\n>\t    > First\n>\t    > Reading marker",
  "literal marker after increasing outer quote indentation":
    "> Outer\n   > - List\n   >   > First\n   >       > Reading marker",
  "code inside a quote with decreasing indentation":
    "   > Outer\n> - List\n>     > ```text\n>     > First\n>     > Reading marker\n>     > ```",
  "GFM table code with an escaped pipe":
    "| Code |\n| --- |\n| `First \\| Reading marker` |",
  "GFM table code with escaped backslashes and pipe":
    "| Code |\n| --- |\n| `First " + "\\".repeat(3) + "| Reading marker` |",
  "GFM table code retaining other escapes":
    "| Code |\n| --- |\n| `First \\* &amp; \\| Reading marker` |",
  "ordinary code retaining pipe escapes": "`First \\| Reading marker`",
  "fenced code retaining pipe escapes":
    "```text\nFirst \\| Reading marker\n```",
};

for (const [kind, source] of Object.entries(cases))
  test(`Markdown source anchors retain exact offsets for ${kind}`, () => {
    const spans = [];
    function collectAnchors() {
      return (tree) => {
        const visit = (node) => {
          if (node.properties?.["data-source-start"] !== undefined)
            spans.push(node);
          node.children?.forEach(visit);
        };
        visit(tree);
      };
    }
    renderToStaticMarkup(
      createElement(Markdown, {
        children: source,
        remarkPlugins: [remarkGfm, remarkSourceAnchors],
        rehypePlugins: [rehypeSourceAnchors, collectAnchors],
      }),
    );
    const text = kind.startsWith("literal")
      ? "> Reading marker"
      : "Reading marker";
    const span = spans.find((node) => node.children[0].value.includes(text));
    assert.ok(
      span,
      "the quoted paragraph or code block must have a text anchor",
    );
    const rendered = span.children[0].value.indexOf(text);
    const runs = span.properties["data-source-runs"]
      ? JSON.parse(span.properties["data-source-runs"])
      : [[0, span.properties["data-source-start"]]];
    for (let index = 0; index < text.length; index++) {
      const run = runs.filter(([start]) => start <= rendered + index).at(-1);
      assert.equal(
        run[1] + rendered + index - run[0],
        source.lastIndexOf(text) + index,
        "map every visible character to its original source position",
      );
    }
  });
