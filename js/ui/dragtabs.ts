// Make the HUD tab panels draggable by their header, while preserving
// click-to-collapse. A tab stays in its default left-stack until you drag it;
// the first real movement detaches it to position:fixed so you can place it
// anywhere (the others reflow). A header press that doesn't move is a click and
// toggles the panel's collapsed state (replacing the old click handler).

export function makeTabsDraggable(rootSel = '#tabs'): void {
  const root = document.querySelector(rootSel);
  if (!root) return;
  for (const tab of root.querySelectorAll('.tab')) {
    const head = tab.querySelector('.tab-head');
    if (head) wireOne(tab as HTMLElement, head as HTMLElement);
  }
}

function wireOne(tab: HTMLElement, head: HTMLElement): void {
  let startX = 0, startY = 0, baseX = 0, baseY = 0, baseW = 0, moved = false, dragging = false;

  const onMove = (e: MouseEvent): void => {
    if (!dragging) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    if (!moved && Math.hypot(dx, dy) < 4) return;          // below threshold -> still a click
    if (!moved) {                                          // first real drag: detach to fixed
      moved = true;
      tab.classList.add('floating');
      tab.style.position = 'fixed';
      tab.style.margin = '0';
      tab.style.width = baseW + 'px';
      tab.style.zIndex = '30';
    }
    const w = tab.offsetWidth, h = tab.offsetHeight;
    tab.style.left = Math.max(0, Math.min(innerWidth - w, baseX + dx)) + 'px';
    tab.style.top = Math.max(0, Math.min(innerHeight - h, baseY + dy)) + 'px';
  };

  const onUp = (): void => {
    dragging = false;
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    if (!moved) tab.classList.toggle('collapsed');         // a click (no drag): toggle collapse
  };

  head.addEventListener('mousedown', (e: MouseEvent) => {
    if (e.button !== 0) return;
    const r = tab.getBoundingClientRect();
    startX = e.clientX; startY = e.clientY; baseX = r.left; baseY = r.top; baseW = r.width;
    moved = false; dragging = true;
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    e.preventDefault();
  });
}
