function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderInline(markdown: string) {
  let html = escapeHtml(markdown.trim());

  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  return html;
}

function isTableDivider(line: string) {
  return /^\|(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(line.trim());
}

function isTableRow(line: string) {
  return /^\|.*\|\s*$/.test(line.trim());
}

function renderTable(lines: string[], startIndex: number) {
  const headerLine = lines[startIndex]?.trim();
  const dividerLine = lines[startIndex + 1]?.trim();

  if (!headerLine || !dividerLine || !isTableRow(headerLine) || !isTableDivider(dividerLine)) {
    return null;
  }

  const rows: string[] = [];
  let index = startIndex + 2;

  while (index < lines.length && isTableRow(lines[index] ?? '')) {
    const row = lines[index];
    if (row) {
      rows.push(row.trim());
    }
    index += 1;
  }

  const toCells = (line: string) =>
    line
      .slice(1, -1)
      .split('|')
      .map((cell) => renderInline(cell.trim()));

  const headerCells = toCells(headerLine)
    .map((cell) => `<th>${cell}</th>`)
    .join('');

  const bodyRows = rows
    .map((row) => {
      const cells = toCells(row)
        .map((cell) => `<td>${cell}</td>`)
        .join('');

      return `<tr>${cells}</tr>`;
    })
    .join('');

  return {
    html: `<div class="legal-table"><table><thead><tr>${headerCells}</tr></thead><tbody>${bodyRows}</tbody></table></div>`,
    nextIndex: index,
  };
}

export function markdownToHtml(markdown: string) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const blocks: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = (lines[index] ?? '').trim();

    if (!line) {
      index += 1;
      continue;
    }

    const table = renderTable(lines, index);
    if (table) {
      blocks.push(table.html);
      index = table.nextIndex;
      continue;
    }

    if (/^---+$/.test(line)) {
      blocks.push('<hr />');
      index += 1;
      continue;
    }

    if (line.startsWith('>')) {
      const quoteLines: string[] = [];
      while (index < lines.length && (lines[index] ?? '').trim().startsWith('>')) {
        quoteLines.push((lines[index] ?? '').trim().replace(/^>\s?/, ''));
        index += 1;
      }
      blocks.push(`<blockquote><p>${quoteLines.map(renderInline).join('<br />')}</p></blockquote>`);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      blocks.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }

    if (line.startsWith('- ')) {
      const items: string[] = [];
      while (index < lines.length && (lines[index] ?? '').trim().startsWith('- ')) {
        items.push((lines[index] ?? '').trim().slice(2));
        index += 1;
      }
      blocks.push(`<ul>${items.map((item) => `<li>${renderInline(item)}</li>`).join('')}</ul>`);
      continue;
    }

    const paragraphLines: string[] = [];
    while (index < lines.length) {
      const current = (lines[index] ?? '').trim();
      if (
        !current ||
        current.startsWith('- ') ||
        current.startsWith('>') ||
        /^---+$/.test(current) ||
        /^(#{1,6})\s+/.test(current) ||
        renderTable(lines, index)
      ) {
        break;
      }

      paragraphLines.push(current);
      index += 1;
    }

    if (paragraphLines.length > 0) {
      blocks.push(`<p>${renderInline(paragraphLines.join(' '))}</p>`);
      continue;
    }

    index += 1;
  }

  return blocks.join('\n');
}
