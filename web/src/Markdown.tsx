import { Fragment, createElement, type ReactNode } from "react";
import { parseMarkdown, type Inline } from "./markdown.ts";

function renderInline(nodes: Inline[]): ReactNode {
  return nodes.map((node, index) => {
    if (node.type === "text") return <Fragment key={index}>{node.text}</Fragment>;
    if (node.type === "bold") return <strong key={index}>{renderInline(node.children)}</strong>;
    return <em key={index}>{renderInline(node.children)}</em>;
  });
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      {parseMarkdown(text).map((block, index) => {
        switch (block.type) {
          case "rule":
            return <hr key={index} />;
          case "heading":
            return createElement(
              `h${block.level}`,
              { key: index },
              renderInline(block.children),
            );
          case "quote":
            return <blockquote key={index}>{renderInline(block.children)}</blockquote>;
          default:
            return <p key={index}>{renderInline(block.children)}</p>;
        }
      })}
    </div>
  );
}
