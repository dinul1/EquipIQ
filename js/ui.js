export const UI = {
    toast(message, type = 'info', duration = 3000) {
        const toast = document.getElementById("toast");
        const toastText = document.getElementById("toastText");
        if (toast && toastText) {
            toastText.textContent = message;
            toast.classList.add('show');
            clearTimeout(window.__toastTimer);
            window.__toastTimer = setTimeout(() => toast.classList.remove('show'), duration);
        }
        let container = document.getElementById('toast-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'toast-container';
            document.body.appendChild(container);
        }
        const t = document.createElement('div');
        t.className = `toast toast-${type}`;
        t.textContent = message;
        container.appendChild(t);
        requestAnimationFrame(() => t.classList.add('show'));
        setTimeout(() => {
            t.classList.remove('show');
            setTimeout(() => t.remove(), 300);
        }, duration);
    },
    openModal(title, html) {
        document.getElementById('modalTitle').innerText = title;
        document.getElementById('modalBody').innerHTML = html;
        document.getElementById('appModal').classList.add('active');
    },
    closeModal() {
        document.getElementById('appModal').classList.remove('active');
    },
    navigate(targetId) {
        const target = document.querySelector(`.nav[data-page="${targetId}"]`);
        if (target) target.click();
    },
    initListeners() {
        document.addEventListener('click', (e) => {
            if (e.target.classList.contains('modal-overlay')) {
                e.target.classList.remove('active');
                document.body.style.overflow = '';
            }
        });
    }
};

export function notify(message) { UI.toast(message, 'info', 3000); }

export function injectSkeleton(elementId, count = 3) {
    const el = document.getElementById(elementId);
    if (!el) return;
    el.innerHTML = Array(count).fill('<div class="skeleton" style="height:24px; margin-bottom:10px;"></div>').join('');
}