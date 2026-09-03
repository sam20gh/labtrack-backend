/**
 * CSV, for the exports an information-governance review asks for.
 *
 * Written rather than pulled in: the whole job is quoting, and a dependency that ships a
 * parser as well doubles the surface for one function.
 *
 * Two things it does that a naive `join(',')` does not:
 *
 * 1. **Quotes anything containing a comma, a quote, or a newline**, doubling embedded
 *    quotes — the one rule that makes the difference between a file a spreadsheet opens and
 *    a file it mangles silently.
 * 2. **Neutralises formula injection.** A cell beginning `=`, `+`, `-` or `@` is executed by
 *    Excel and Sheets when the file is opened. Values here come from user-controlled fields
 *    (names, emails), so an export is a way to hand an administrator a spreadsheet that runs
 *    somebody else's formula on open. Prefixing with `'` keeps the text visible and inert.
 */

const RISKY_PREFIX = /^[=+\-@\t\r]/;

const cell = (value) => {
    if (value === null || value === undefined) return '';
    let text = value instanceof Date ? value.toISOString() : String(value);
    if (RISKY_PREFIX.test(text)) text = `'${text}`;
    if (/[",\n\r]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
    return text;
};

/**
 * @param {{key: string, label: string}[]} columns
 * @param {object[]} rows
 * @returns {string} CSV including a header row, CRLF-terminated per RFC 4180
 */
const toCsv = (columns, rows) => {
    const header = columns.map((c) => cell(c.label ?? c.key)).join(',');
    const body = rows.map((row) => columns.map((c) => cell(row[c.key])).join(','));
    return [header, ...body].join('\r\n') + '\r\n';
};

/** Send a CSV as a download, with a filename the browser will keep. */
const sendCsv = (res, filename, columns, rows) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(toCsv(columns, rows));
};

module.exports = { toCsv, sendCsv, cell };
