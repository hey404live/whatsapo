/** Conserva los nodos que siguen en el mismo lugar, incluidos los elementos img cargados. */
export function reconcileChildren(parent: Element, children: readonly Element[]) {
  const retained = new Set(children);
  for (const child of Array.from(parent.children)) {
    if (!retained.has(child)) child.remove();
  }
  let cursor = parent.firstElementChild;
  for (const child of children) {
    if (cursor === child) {
      cursor = cursor.nextElementSibling;
    } else {
      parent.insertBefore(child, cursor);
    }
  }
  while (cursor) {
    const next = cursor.nextElementSibling;
    cursor.remove();
    cursor = next;
  }
}
