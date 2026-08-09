/**
 * Saving what is on screen to a file.
 *
 * Generate produces artifacts — a sampled set, a study result — that only become useful
 * once they leave the browser, so both stages need the same three lines. The object URL
 * is revoked on the next frame rather than immediately: Safari has historically cancelled
 * the download when the URL disappears in the same tick as the click.
 */
function save(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  requestAnimationFrame(() => URL.revokeObjectURL(url));
}

export function downloadJson(filename: string, data: unknown): void {
  save(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), filename);
}

export function downloadText(filename: string, text: string): void {
  save(new Blob([text], { type: 'text/plain;charset=utf-8' }), filename);
}

/**
 * Copy to the clipboard, reporting whether it worked.
 *
 * `navigator.clipboard` is absent on insecure origins, which includes a workbench opened
 * at a LAN address rather than localhost, so the caller has to be able to say "copy
 * failed" instead of silently doing nothing.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
