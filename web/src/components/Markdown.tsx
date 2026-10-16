import type { ReactNode } from "react";

/**
 * Tiny safe markdown renderer: headings (#..###), paragraphs, bullet lists,
 * **bold** and *italic*. Builds React elements only, so text is always escaped.
 */

function renderInline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*)/g;
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(re)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(text.slice(last, idx));
    if (m[2] !== undefined) out.push(<strong key={`${keyBase}-b${i++}`}>{m[2]}</strong>);
    else out.push(<em key={`${keyBase}-i${i++}`}>{m[3]}</em>);
    last = idx + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type Block =
  | { type: "h"; level: number; text: string }
  | { type: "p"; text: string }
  | { type: "ul"; items: string[] };

function parse(src: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: string[] | null = null;

  const endPara = () => {
    if (para.length) blocks.push({ type: "p", text: para.join(" ") });
    para = [];
  };
  const endList = () => {
    if (list) blocks.push({ type: "ul", items: list });
    list = null;
  };

  for (const raw of src.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trim();
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const bullet = /^[-*•]\s+(.*)$/.exec(line) ?? /^\d+[.)]\s+(.*)$/.exec(line);
    if (!line) {
      endPara();
      endList();
    } else if (heading) {
      endPara();
      endList();
      blocks.push({ type: "h", level: Math.min(heading[1].length, 3), text: heading[2] });
    } else if (bullet) {
      endPara();
      (list ??= []).push(bullet[1]);
    } else if (list) {
      // Continuation line of the previous bullet.
      list[list.length - 1] += ` ${line}`;
    } else {
      para.push(line);
    }
  }
  endPara();
  endList();
  return blocks;
}

export function Markdown({ source, className }: { source: string; className?: string }) {
  const blocks = parse(source);
  return (
    <div className={`md ${className ?? ""}`}>
      {blocks.map((b, i) => {
        const k = `blk${i}`;
        if (b.type === "h") {
          const content = renderInline(b.text, k);
          if (b.level === 1) return <h3 key={k}>{content}</h3>;
          if (b.level === 2) return <h4 key={k}>{content}</h4>;
          return <h5 key={k}>{content}</h5>;
        }
        if (b.type === "ul")
          return (
            <ul key={k}>
              {b.items.map((it, j) => (
                <li key={j}>{renderInline(it, `${k}-${j}`)}</li>
              ))}
            </ul>
          );
        return <p key={k}>{renderInline(b.text, k)}</p>;
      })}
    </div>
  );
}
