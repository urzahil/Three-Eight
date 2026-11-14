const $ = (id) => document.getElementById(id);

function toast(text, ms = 3000) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

async function api(method, path, body) {
  const res = await fetch('/api/admin' + path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Error ${res.status}`), { status: res.status });
  return data;
}

let serviceAccount = ''; // email of the Google service account the server uses, '' if Drive is not set up
const driveNames = new Map(); // room name -> verified folder name (memory only)

function driveLink(d) {
  return `https://drive.google.com/drive/folders/${d.folderId}`;
}

function roomUrl(name) {
  return `${location.origin}/${encodeURIComponent(name)}`;
}

async function refresh() {
  let data;
  try {
    data = await api('GET', '/rooms');
  } catch (err) {
    if (err.status === 401) return showLogin();
    toast(err.message);
    return;
  }
  serviceAccount = data.serviceAccount || '';
  const tbody = $('rooms');
  tbody.replaceChildren(...data.rooms.map((r) => {
    const tr = document.createElement('tr');
    const tdName = document.createElement('td');
    const a = document.createElement('a');
    a.href = roomUrl(r.name);
    a.textContent = r.name;
    a.target = '_blank';
    tdName.append(a);
    const tdPw = document.createElement('td');
    tdPw.textContent = r.hasPassword ? 'set' : 'none';
    tdPw.className = r.hasPassword ? '' : 'muted';
    const tdDrive = document.createElement('td');
    tdDrive.textContent = r.drive ? (driveNames.get(r.name + '|' + r.drive.folderId) || 'linked') : '—';
    if (!r.drive) tdDrive.className = 'muted';
    const tdOnline = document.createElement('td');
    tdOnline.textContent = r.online.length ? r.online.join(', ') : '—';
    if (!r.online.length) tdOnline.className = 'muted';
    const tdAct = document.createElement('td');
    const copy = button('Copy link', async () => {
      try {
        await navigator.clipboard.writeText(roomUrl(r.name));
        toast('Link copied');
      } catch {
        prompt('Room link', roomUrl(r.name));
      }
    });
    const pw = button('Password…', () => changePassword(r.name));
    const drv = button('Drive…', () => changeDrive(r.name, r.drive));
    const del = button('Delete', async () => {
      if (!confirm(`Delete room “${r.name}”? Anyone inside will be disconnected.`)) return;
      try {
        await api('DELETE', '/rooms/' + encodeURIComponent(r.name), {});
        toast('Room deleted');
      } catch (err) {
        toast(err.message);
      }
      refresh();
    });
    del.classList.add('danger');
    tdAct.append(copy, ' ', pw, ' ', drv, ' ', del);
    tr.append(tdName, tdPw, tdDrive, tdOnline, tdAct);
    return tr;
  }));
  $('empty').hidden = data.rooms.length > 0;
}

function button(label, onClick) {
  const b = document.createElement('button');
  b.className = 'btn';
  b.type = 'button';
  b.textContent = label;
  b.onclick = onClick;
  return b;
}

function changePassword(name) {
  const d = $('pw-dialog');
  $('pw-room').textContent = name;
  $('pw-new').value = '';
  $('pw-kick').checked = false;
  d.returnValue = 'cancel';
  d.showModal();
  d.addEventListener('close', async () => {
    if (d.returnValue !== 'save') return;
    try {
      await api('PUT', '/rooms/' + encodeURIComponent(name), { password: $('pw-new').value, kick: $('pw-kick').checked });
      toast('Password updated');
    } catch (err) {
      toast(err.message);
    }
    refresh();
  }, { once: true });
}

function changeDrive(name, current) {
  const d = $('drive-dialog');
  $('drive-room').textContent = name;
  $('drive-link').value = current ? driveLink(current) : '';
  $('drive-share').hidden = !serviceAccount;
  $('drive-sa').textContent = serviceAccount;
  $('drive-nosa').hidden = !!serviceAccount;
  $('drive-remove').hidden = !current;
  d.returnValue = 'cancel';
  d.showModal();
  d.addEventListener('close', async () => {
    if (d.returnValue !== 'save' && d.returnValue !== 'remove') return;
    const link = d.returnValue === 'remove' ? '' : $('drive-link').value.trim();
    let result;
    try {
      result = await api('PUT', '/rooms/' + encodeURIComponent(name) + '/drive', { link });
    } catch (err) {
      toast(err.message);
      return;
    }
    const { drive, check } = result;
    if (!drive) toast('Drive folder removed');
    else if (!check) toast('Folder saved');
    else if (check.error) toast(`Saved, but the folder could not be read: ${check.error}`, 10000);
    else {
      driveNames.set(name + '|' + drive.folderId, check.name);
      toast(`Folder “${check.name}” linked: ${check.items} items`);
    }
    refresh();
  }, { once: true });
}

$('drive-copy').onclick = async () => {
  try {
    await navigator.clipboard.writeText(serviceAccount);
    toast('Email copied');
  } catch {
    const el = $('drive-sa');
    const range = document.createRange();
    range.selectNodeContents(el);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    toast('Copy the selected email');
  }
};

function showLogin() {
  $('panel').hidden = true;
  $('login').hidden = false;
  $('login-password').focus();
  clearInterval(window._refresh);
}

function showPanel() {
  $('login').hidden = true;
  $('panel').hidden = false;
  refresh();
  clearInterval(window._refresh);
  window._refresh = setInterval(refresh, 10000);
}

$('url-example').textContent = `${location.origin}/ROOM_NAME`;

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-error').hidden = true;
  try {
    await api('POST', '/login', { password: $('login-password').value });
    $('login-password').value = '';
    showPanel();
  } catch (err) {
    $('login-error').textContent = err.message;
    $('login-error').hidden = false;
  }
});

$('logout').onclick = async () => {
  await api('POST', '/logout', {}).catch(() => {});
  showLogin();
};

$('create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('create-error').hidden = true;
  const name = $('create-name').value.trim();
  try {
    await api('POST', '/rooms', { name, password: $('create-password').value });
    $('create-name').value = '';
    $('create-password').value = '';
    toast(`Room “${name}” created`);
    refresh();
  } catch (err) {
    $('create-error').textContent = err.message;
    $('create-error').hidden = false;
  }
});

api('GET', '/session').then(showPanel, showLogin);
