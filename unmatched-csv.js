function unmatchedCsv(rows) {
  const columns = ['media_type', 'original_filename', 'original_path', 'search_title', 'status'];
  const cell = value => {
    let text = String(value ?? '');
    // Prevent filenames and titles from becoming spreadsheet formulas.
    if (/^[\s]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  };
  return '\uFEFF' + [columns.map(cell).join(','), ...rows.map(row => columns.map(column => cell(row[column])).join(','))].join('\r\n') + '\r\n';
}

module.exports = { unmatchedCsv };
