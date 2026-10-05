// CSV for the file preview: no DOM, so it loads under node for its test.

/** Splits CSV text into rows of cells: commas, quoted fields, "" for a quote inside one. */
export function parseCsv (text, maxRows = 200) {
  const rows = []
  let row = []; let cell = ''; let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c !== '"') cell += c
      else if (text[i + 1] === '"') { cell += '"'; i++ } else quoted = false
    } else if (c === '"' && cell === '') quoted = true
    else if (c === ',') { row.push(cell); cell = '' } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(cell); rows.push(row); row = []; cell = ''
      if (rows.length >= maxRows) return rows
    } else cell += c
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row) }
  return rows
}
