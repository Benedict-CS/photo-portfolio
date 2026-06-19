(function(){const prevHref = "/photos/---IMG-20180120-WA0001";
const nextHref = "/photos/---IMG_20260619_152734";
const originalUrl = "https://cloud.ben.winlab.tw/s/65XGM5PRjLPnj8q/download?path=%2F%E6%97%A5%E6%9C%AC&files=IMG_20260619_152610.jpg";
const photoPath = "日本/IMG_20260619_152610.jpg";
const initialLat = 35.71388888888889;
const initialLon = 139.76921111111113;
const manualLocation = false;
const initialDate = "2024-12-26";
const exifProvidedLocation = true;
const exifProvidedDate = true;
const anythingEditable = false;

  document.addEventListener('keydown', (e) => {
    if (document.getElementById('loc-modal')?.hidden === false) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.key === 'ArrowLeft' && prevHref) window.location.href = prevHref;
    else if (e.key === 'ArrowRight' && nextHref) window.location.href = nextHref;
    else if (e.key === 'Escape') {
      if (window.history.length > 1) window.history.back();
      else window.location.href = '/';
    }
  });

  document.getElementById('hero')?.addEventListener('click', () => {
    window.open(originalUrl, '_blank');
  });

  // Note: back-btn click is wired via inline onclick (simpler, no race
  // with other JS). Esc key handled in the keydown listener above.

  // ---- Location + date editor modal ----
  const modal = document.getElementById('loc-modal');
  const status = document.getElementById('loc-status');
  const saveBtn = document.getElementById('loc-save');
  const cancelBtn = document.getElementById('loc-cancel');
  const removeBtn = document.getElementById('loc-remove');
  const dateInput = document.getElementById('loc-date');
  const dateClear = document.getElementById('loc-date-clear');

  let map = null;
  let marker = null;
  let pendingLatLng = null;
  let savedLatLng = initialLat !== null && initialLon !== null
    ? { lat: initialLat, lng: initialLon }
    : null;
  let savedDate = initialDate || '';
  let pendingDate = savedDate;

  function isLocDirty() {
    if (exifProvidedLocation) return false;  // EXIF locked, never dirty
    if (!pendingLatLng) return false;
    if (!savedLatLng) return true;
    return Math.abs(pendingLatLng.lat - savedLatLng.lat) > 1e-6
        || Math.abs(pendingLatLng.lng - savedLatLng.lng) > 1e-6;
  }
  function isDateDirty() {
    if (exifProvidedDate) return false;       // EXIF locked, never dirty
    return pendingDate !== savedDate;
  }
  function isDirty() { return isLocDirty() || isDateDirty(); }

  function updateStatus() {
    saveBtn.disabled = !isDirty();
    if (removeBtn) removeBtn.hidden = !manualLocation || !savedLatLng;
    let parts = [];
    if (savedLatLng) parts.push(`位置:${savedLatLng.lat.toFixed(4)}, ${savedLatLng.lng.toFixed(4)}`);
    else parts.push('位置:未設定');
    if (savedDate) parts.push(`日期:${savedDate}`);
    if (isDirty()) {
      status.className = 'loc-status dirty';
      const changes = [];
      if (isLocDirty()) changes.push(`位置→ ${pendingLatLng.lat.toFixed(4)}, ${pendingLatLng.lng.toFixed(4)}`);
      if (isDateDirty()) changes.push(`日期→ ${pendingDate || '(清除)'}`);
      status.textContent = `未儲存:${changes.join(' · ')}`;
    } else {
      status.className = 'loc-status';
      status.textContent = parts.join(' · ');
    }
  }

  function setPin(latLng) {
    pendingLatLng = { lat: latLng.lat, lng: latLng.lng };
    if (marker) {
      marker.setLatLng(latLng);
    } else {
      marker = L.marker(latLng, { draggable: true }).addTo(map);
      marker.on('dragend', () => {
        pendingLatLng = { lat: marker.getLatLng().lat, lng: marker.getLatLng().lng };
        updateStatus();
      });
    }
    updateStatus();
  }

  function openLocModal() {
    modal.hidden = false;
    // EXIF is authoritative: hide whatever EXIF already provided so the user
    // can ONLY fill in what's missing.
    const dateRow = document.querySelector('.loc-date-row');
    const mapEl = document.getElementById('loc-map');
    if (dateRow) dateRow.style.display = exifProvidedDate ? 'none' : '';
    if (mapEl) mapEl.style.display = exifProvidedLocation ? 'none' : '';
    if (!exifProvidedLocation && !map) {
      map = L.map('loc-map', { worldCopyJump: true });
      L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
        maxZoom: 19, subdomains: 'abcd', attribution: '&copy; OpenStreetMap &copy; CARTO',
      }).addTo(map);
      const startLat = initialLat ?? 23.5;
      const startLon = initialLon ?? 121;
      map.setView([startLat, startLon], initialLat ? 11 : 4);
      if (initialLat) setPin({ lat: startLat, lng: startLon });
      map.on('click', (e) => setPin(e.latlng));
    }
    dateInput.value = pendingDate;
    updateStatus();
    if (map) setTimeout(() => map.invalidateSize(), 50);
  }

  function closeLocModal() {
    if (isDirty() && !confirm('還有未儲存的變更,確定要離開嗎?')) return;
    // Reset pending state to last-saved so reopening doesn't keep stale data
    pendingLatLng = savedLatLng ? { ...savedLatLng } : null;
    pendingDate = savedDate;
    if (marker && savedLatLng) marker.setLatLng(savedLatLng);
    if (dateInput) dateInput.value = pendingDate;
    modal.hidden = true;
  }

  // Inline mini-auth helper — sends saved token; on 401 prompts once.
  const TOKEN_KEY = 'photo-admin-token';
  async function authedFetch(url, init = {}) {
    async function go(token) {
      const headers = new Headers(init.headers || {});
      if (token) headers.set('Authorization', `Bearer ${token}`);
      return fetch(url, { ...init, headers });
    }
    let res = await go(localStorage.getItem(TOKEN_KEY) || '');
    if (res.status !== 401) return res;
    const entered = await (window).promptPassword?.('需要管理員密碼才能編輯');
    if (!entered) return res;
    localStorage.setItem(TOKEN_KEY, entered);
    res = await go(entered);
    if (res.status === 401) {
      localStorage.removeItem(TOKEN_KEY);
      throw new Error('密碼錯誤');
    }
    return res;
  }

  async function postMetadata(body) {
    const res = await authedFetch('/api/metadata', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: photoPath, ...body }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'save failed');
    return data.photo;
  }

  function toast(type, message) {
    window.dispatchEvent(new CustomEvent('toast:show', { detail: { type, message } }));
  }

  async function doSave() {
    saveBtn.disabled = true;
    saveBtn.classList.add('loading');
    status.className = 'loc-status saving';
    status.textContent = '儲存中…';
    try {
      const body = {};
      if (isLocDirty() && pendingLatLng) {
        body.lat = pendingLatLng.lat;
        body.lon = pendingLatLng.lng;
      }
      if (isDateDirty()) body.datetime = pendingDate || null;
      const updated = await postMetadata(body);
      if (updated) {
        if (updated.lat !== null && updated.lon !== null) {
          savedLatLng = { lat: updated.lat, lng: updated.lon };
          if (marker) marker.setLatLng([updated.lat, updated.lon]);
        }
        savedDate = updated.datetime ? updated.datetime.slice(0, 10) : '';
        pendingDate = savedDate;
        if (dateInput) dateInput.value = pendingDate;
      }
      updateStatus();
      saveBtn.classList.remove('loading');
      // Auto-close + toast so the photo is visible and feedback is clear.
      modal.hidden = true;
      const country = updated?.country || '';
      toast('success', country ? `已存到 ${country}` : '已存');
    } catch (err) {
      status.className = 'loc-status error';
      status.textContent = `⚠ 失敗:${err.message || err}`;
      saveBtn.disabled = false;
      saveBtn.classList.remove('loading');
      toast('error', `儲存失敗:${err.message || err}`);
    }
  }

  async function doRemove() {
    if (!confirm('確定要移除手動位置?照片會回到「未定位」分類。')) return;
    try {
      await postMetadata({ lat: null, lon: null });
      toast('success', '已移除手動位置');
      // Brief delay so the toast is seen before navigation.
      setTimeout(() => { window.location.href = '/timeline'; }, 600);
    } catch (err) {
      toast('error', `移除失敗:${err.message || err}`);
    }
  }

  dateInput.addEventListener('input', () => {
    pendingDate = dateInput.value;
    updateStatus();
  });
  dateClear.addEventListener('click', () => {
    pendingDate = '';
    dateInput.value = '';
    updateStatus();
  });

  document.getElementById('set-location')?.addEventListener('click', openLocModal);
  document.getElementById('loc-close')?.addEventListener('click', closeLocModal);
  cancelBtn?.addEventListener('click', closeLocModal);
  saveBtn?.addEventListener('click', doSave);
  removeBtn?.addEventListener('click', doRemove);
  document.getElementById('revert-location')?.addEventListener('click', doRemove);

  document.getElementById('favorite-btn')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const now = btn.dataset.fav === '1';
    const next = !now;
    btn.dataset.fav = next ? '1' : '0';
    btn.classList.toggle('on', next);
    btn.textContent = next ? '⭐' : '☆';
    try {
      await postMetadata({ favorite: next });
      toast('success', next ? '⭐ 加入收藏' : '已取消收藏');
    } catch (err) {
      // Rollback on error
      btn.dataset.fav = now ? '1' : '0';
      btn.classList.toggle('on', now);
      btn.textContent = now ? '⭐' : '☆';
      toast('error', `失敗:${err.message || err}`);
    }
  });

  document.getElementById('copy-link')?.addEventListener('click', async () => {
    const url = window.location.href.replace(/\?pin=1$/, '');
    try {
      await navigator.clipboard.writeText(url);
      toast('success', '✓ 已複製連結');
    } catch {
      // Fallback for non-https contexts.
      const ta = document.createElement('textarea');
      ta.value = url;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      toast('success', '✓ 已複製連結');
    }
  });

  document.getElementById('delete-photo')?.addEventListener('click', async () => {
    if (!confirm('永久刪除這張照片?\n\n會從 Nextcloud 連同檔案一起刪除,且無法復原。')) return;
    try {
      const res = await authedFetch('/api/metadata', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: photoPath }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'delete failed');
      toast('success', '已刪除');
      setTimeout(() => { window.location.href = '/timeline'; }, 500);
    } catch (err) {
      toast('error', `刪除失敗:${err.message || err}`);
    }
  });
  modal?.addEventListener('click', (e) => { if (e.target === modal) closeLocModal(); });

  // Only auto-open the modal when the user EXPLICITLY came here to edit
  // (?pin=1 query param). Otherwise let them view the photo in peace and
  // click the edit button themselves when they're ready.
  if (anythingEditable) {
    const url = new URL(window.location.href);
    if (url.searchParams.get('pin') === '1') {
      setTimeout(openLocModal, 80);
    }
  }
})();