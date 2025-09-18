import { InvalidProgramState } from '@cashlab/common';
import type { TimeoutId } from './internal/types.js';

export function addInteractionResponseToast (event: MouseEvent, { message, signal, display_time, type }: { message: string, display_time?: number, signal?: AbortSignal, type?: 'success' | 'error' | null }): void {
  display_time = display_time || 2500;
  let bclass;
  if (type === 'success') {
    bclass = 'text-gray-200 bg-green-700 dark:text-gray-200 dark:bg-green-700';
  } else if (type === 'error') {
    bclass = 'text-gray-200 bg-red-700 dark:text-gray-200 dark:bg-red-700';
  } else {
    bclass = 'text-gray-900 bg-gray-300 dark:text-gray-200 dark:bg-gray-700';
  }
  const html = `
<div class="absolute block px-3 py-1 rounded-sm transition duration-300 ease-in-out opacity-0 ${bclass}">
  <span class="message font-medium"></span>
</div>
  `;
  let parent_node;
  {
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    parent_node = Array.from(tmp.childNodes).filter((a) => a?.nodeType === Node.ELEMENT_NODE)[0] as HTMLElement;
    if (parent_node == null) {
      throw new InvalidProgramState('parent_node == null!!');
    }
  }
  const clear = () => {
    if (signal != null) {
      signal.removeEventListener('abort', onAbort);
    }
    if (timeout_id != null) {
      clearTimeout(timeout_id);
      timeout_id = null;
    }
  };
  const onEnd = () => {
    parent_node.classList.add('opacity-0');
    setTimeout(() => {
      if (parent_node.parentNode == null) {
        return
      }
      parent_node.parentNode.removeChild(parent_node);
    }, 300);
  };
  const onAbort = () => {
    clear();
    onEnd();
  };
  let timeout_id: TimeoutId | null = setTimeout(() => {
    timeout_id = null;
    clear();
    onEnd();
  }, display_time);
  if (signal) {
    signal.addEventListener('abort', onAbort);
  }
  (parent_node.querySelector('.message') as HTMLElement).textContent = message;
  document.body.appendChild(parent_node);
  const rect = parent_node.getBoundingClientRect();
  const offset_y = 25;
  const offset_x = -1 * rect.width / 2;
  parent_node.style.top = (event.clientY + offset_y) + 'px';
  parent_node.style.left = (event.clientX + offset_x) + 'px';
  // fade in
  parent_node.classList.remove('opacity-0');
}
