/* Subscribe 모달 공통 로직 — 실제 edtechhub.com의 user_mail_action.php와 동일한 필드(email/full_name/role)·검증 규칙을 따름.
   각 페이지는 이 스크립트를 로드하고, id="modal-subscribe" 마크업 + Subscribe 버튼에
   onclick="openModal('modal-subscribe');return false;" 만 붙이면 됨. */
(function () {
  function openModal(id) {
    var el = document.getElementById(id);
    if (!el) return;
    el.hidden = false;
    document.body.style.overflow = 'hidden';
  }
  function closeModal(id) {
    var el = document.getElementById(id);
    if (!el) return;
    el.hidden = true;
    document.body.style.overflow = '';
  }
  window.openModal = openModal;
  window.closeModal = closeModal;

  var FULL_NAME_PATTERN = /^[A-Za-z\s]+$/;
  var EMAIL_PATTERN = /^[\w-]+(\.[\w-]+)*@([\w-]+\.)+[a-zA-Z]+$/;

  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('.modal-overlay').forEach(function (overlay) {
      overlay.addEventListener('click', function (e) {
        if (e.target === overlay) closeModal(overlay.id);
      });
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      document.querySelectorAll('.modal-overlay:not([hidden])').forEach(function (overlay) {
        closeModal(overlay.id);
      });
    });

    var form = document.getElementById('subscribe-form');
    if (!form) return;
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      var errEl = document.getElementById('subscribe-error');
      var btn = form.querySelector('.modal-submit');
      var email = document.getElementById('sub-email').value.trim();
      var full_name = document.getElementById('sub-name').value.trim();
      var role = document.getElementById('sub-role').value;
      function showErr(msg) { errEl.textContent = msg; errEl.hidden = false; }
      errEl.hidden = true;
      if (!email) return showErr('Please enter your email.');
      if (!EMAIL_PATTERN.test(email)) return showErr('This is not a valid email format.');
      if (!full_name) return showErr('Please enter your full name.');
      if (!FULL_NAME_PATTERN.test(full_name) || full_name.length < 5 || full_name.length > 30)
        return showErr('Full name must be 5–30 letters (no numbers or symbols).');
      if (!role) return showErr('Please choose your role.');
      btn.disabled = true;
      try {
        var r = await fetch('/api/user-mailing', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email, full_name: full_name, role: role }),
        });
        var data = await r.json();
        if (!r.ok || data.status !== 0) throw new Error(data.msg || 'error');
        alert("You're now subscribed to our mailing list.");
        form.reset();
        closeModal('modal-subscribe');
      } catch (err) {
        showErr('The request could not be processed due to a temporary error. Please try again later.');
      } finally {
        btn.disabled = false;
      }
    });
  });
})();
