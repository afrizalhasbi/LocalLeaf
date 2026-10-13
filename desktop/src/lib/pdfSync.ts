// PDF → code SyncTeX from the part of the PDF currently in view (← arrow and menu bar).
import { syncToCode } from "./store";

export function syncFromPdfView() {
  const scroller = document.querySelector<HTMLElement>(".pdf-page")?.parentElement?.parentElement;
  if (!scroller) return;
  const mid = scroller.getBoundingClientRect().top + scroller.clientHeight / 3;
  const page = [...scroller.querySelectorAll<HTMLElement>(".pdf-page")].find((el) => {
    const r = el.getBoundingClientRect();
    return r.top <= mid && r.bottom >= mid;
  });
  if (!page) return;
  const r = page.getBoundingClientRect();
  const scale = parseFloat(page.style.getPropertyValue("--total-scale-factor")) || 1;
  void syncToCode(Number(page.dataset.page), r.width / 2 / scale, (mid - r.top) / scale);
}
