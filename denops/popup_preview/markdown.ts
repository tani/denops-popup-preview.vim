import { batch, Denops, fn, gather, vars } from "./deps.ts";
type MarkedString = string | { language: string; value: string };
export type MarkupKind = "plaintext" | "markdown";
export type MarkupContent = {
  kind: MarkupKind;
  value: string;
};

// --- Converts any of `MarkedString` | `MarkedString[]` | `MarkupContent` into
// --- a list of lines containing valid markdown. Useful to populate the hover
// --- window for `textDocument/hover`, for parsing the result of
// --- `textDocument/signatureHelp`, and potentially others.
// ---
// --@param input (`MarkedString` | `MarkedString[]` | `MarkupContent`)
// --@param contents (table, optional, default `{}`) List of strings to extend with converted lines
// --@returns {contents}, extended with lines of converted markdown.
// --@see https://microsoft.github.io/language-server-protocol/specifications/specification-current/#textDocument_hover
export function convertInputToMarkdownLines(
  input: MarkedString | MarkedString[] | MarkupContent,
  contents: string[],
): string[] {
  if (typeof input == "string") {
    contents = contents.concat(input.split("\n"));
  } else {
    if ("kind" in input) {
      let value = input.value;
      if (input.kind == "plaintext") {
        value = "<text>\n" + input.value + "\n</text>";
      }
      contents = contents.concat(value.split("\n"));
    } else if ("language" in input) {
      // MarkedString
      contents.push("```" + input.language);
      contents = contents.concat(input.value.split("\n"));
      contents.push("```");
    } else {
      contents = input.flatMap((mstr) =>
        convertInputToMarkdownLines(mstr, contents)
      );
    }
  }
  if (contents.length == 1 && contents[0] == "") {
    return [];
  }

  return contents;
}

export async function makeFloatingwinSize(
  denops: Denops,
  lines: string[],
  maxWidth: number,
  maxHeight: number,
  border: boolean,
): Promise<[number, number]> {
  if (border) {
    maxWidth -= 2;
    maxHeight -= 2;
  }
  const widths = await gather(denops, async (denops) => {
    for (const line of lines) {
      await fn.strdisplaywidth(denops, line);
    }
  }) as number[];
  const width = Math.min(Math.max(...widths), maxWidth);

  let height = 0;
  for (const w of widths) {
    height += Math.floor((w ? w - 1 : 0) / width) + 1;
  }
  height = Math.min(maxHeight, height);
  return [width, height];
}

export function getMarkdownFences(items: string[]) {
  const fences: Record<string, string> = {};
  for (const item of items) {
    const maybe = item.split("=");
    if (maybe.length == 2) {
      fences[maybe[0]] = maybe[1];
    }
  }
  return fences;
}

type Matcher = {
  ft: string;
  begin: string;
  end: string;
};

type Match = {
  ft: string | null;
  type: string;
};

type Highlight = {
  ft: string | null;
  start: number;
  finish: number;
};

type HighlightContent = {
  stripped: string[];
  highlights: Highlight[];
  width: number;
  height: number;
};

type FloatOption = {
  maxWidth: number;
  maxHeight: number;
  separator?: string;
  syntax: string;
  border: boolean;
};

export async function getHighlights(
  denops: Denops,
  contents: string[],
  opts: FloatOption,
): Promise<HighlightContent> {
  if (opts.syntax != "markdown") {
    const [width, height] = await makeFloatingwinSize(
      denops,
      contents,
      opts.maxWidth,
      opts.maxHeight,
      opts.border,
    );
    return {
      stripped: contents,
      width: width,
      height: height,
      highlights: [],
    };
  }
  const matchers: Record<string, Matcher> = {
    block: { ft: "", begin: "```+([a-zA-Z0-9_]*)", end: "```+" }, // block
    pre: { ft: "", begin: "<pre>", end: "<\/pre>" }, // pre
    code: { ft: "", begin: "<code>", end: "<\/code>" }, // code
    text: { ft: "plaintex", begin: "<text>", end: "<\/text>" }, // text
  };
  const fences = getMarkdownFences(
    await vars.g.get(
      denops,
      "markdown_fenced_languages",
      [],
    ) as string[],
  );

  function matchBegin(line: string): Match | null {
    for (const type of Object.keys(matchers)) {
      const matcher = matchers[type];
      const match = line.match(matcher.begin);
      if (match) {
        return {
          type: type,
          ft: matcher.ft ? matcher.ft : match[1] ? match[1] : null,
        };
      }
    }
    return null;
  }

  function matchEnd(line: string, match: Match): boolean {
    return line.search(matchers[match.type].end) != -1;
  }

  const stripped: string[] = [];
  const highlights: Highlight[] = [];
  const markdownLines: boolean[] = [];
  for (let i = 0; i < contents.length;) {
    const line = contents[i];
    const match = matchBegin(line);
    if (match) {
      const start = stripped.length;
      if (match.ft) {
        match.ft = fences[match.ft] ? fences[match.ft] : match.ft;
      }
      i++;
      if (contents[i] && !matchEnd(contents[i], match)) {
        // stripped.push("---");
        // markdownLines[stripped.length - 1] = true;
        stripped.push("```" + match.ft + " " + contents[i]);
        i++;
      }
      while (i < contents.length) {
        const fencedLine = contents[i];
        if (matchEnd(fencedLine, match)) {
          stripped[stripped.length - 1] = stripped[stripped.length - 1] +
            " ```";
          i++;
          break;
        }
        stripped.push(fencedLine);
        i++;
      }
      highlights.push({
        ft: match.ft,
        start: start + 1,
        finish: stripped.length,
      });
      // add separator
      // if (i < contents.length) {
      //   stripped.push("");
      //   markdownLines[stripped.length - 1] = true;
      // }
    } else {
      // strip any emty lines or separators prior to this separator in actual markdown
      if (/^---+$/.test(line)) {
        while (
          markdownLines[stripped.length - 1] &&
          (/^\s*$/.test(stripped[stripped.length - 1]) ||
            (/^---+$/.test(stripped[stripped.length - 1])))
        ) {
          markdownLines[stripped.length - 1] = false;
          stripped.pop();
        }
      }
      // add the line if its not an empty line following a separator
      if (
        !(/^\s*$/.test(line) && markdownLines[stripped.length - 1] &&
          /^---+$/.test(stripped[stripped.length - 1]))
      ) {
        stripped.push(line);
        markdownLines[stripped.length - 1] = true;
      }
      i++;
    }
  }

  const [width, height] = await makeFloatingwinSize(
    denops,
    stripped,
    opts.maxWidth,
    opts.maxHeight,
    opts.border,
  );
  const sepLine = "─".repeat(width);
  // replace --- with line separator
  for (let i = 0; i < stripped.length; i++) {
    if (/^---+$/.test(stripped[i]) && markdownLines[i]) {
      stripped[i] = sepLine;
    }
  }
  return {
    stripped: stripped,
    highlights: highlights,
    width: width,
    height: height,
  };
}
