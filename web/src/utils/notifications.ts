/**
 * Browser notification utilities.
 * No React hooks — pure functions to avoid re-render coupling.
 */

let permissionGranted = Notification.permission === 'granted';
let unreadCount = 0;
const originalTitle = document.title;

/** Request notification permission (call once on user interaction). */
export function requestNotificationPermission(): void {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') {
    Notification.requestPermission().then((p) => {
      permissionGranted = p === 'granted';
    });
  }
}

/** Show a desktop notification if tab is not focused. */
export function notifyTaskComplete(botName: string, preview?: string): void {
  if (document.hasFocus()) return;

  // Update unread count in tab title
  unreadCount++;
  document.title = `(${unreadCount}) ${originalTitle}`;

  // Desktop notification
  if (permissionGranted) {
    try {
      const n = new Notification(`${botName} — Task Complete`, {
        body: preview?.slice(0, 100) || 'Task finished',
        icon: '/web/favicon.ico',
        tag: 'metabot-task', // replaces previous
      });
      // Auto-close after 5s
      setTimeout(() => n.close(), 5000);
    } catch {
      // Notification API not available (e.g. insecure context)
    }
  }
}

/** Reset unread count when tab regains focus. */
function onFocus() {
  if (unreadCount > 0) {
    unreadCount = 0;
    document.title = originalTitle;
  }
}

window.addEventListener('focus', onFocus);
