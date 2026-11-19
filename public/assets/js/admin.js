const $ = (id) => document.getElementById(id);

function toast(text, ms = 3000, kind = '') {
  const el = document.createElement('div');
  el.className = kind ? `toast ${kind}` : 'toast';
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
    else if (!r.hasPassword) {
      // Anyone who knows the room's name can join, and so stream the folder.
      tdDrive.textContent += ' · no password';
      tdDrive.title = 'This room has no password: anyone with its link can stream this folder.';
      tdDrive.className = 'warning';
    }
    const tdOnline = document.createElement('td');
    const members = r.members || [];
    if (!members.length) {
      tdOnline.textContent = '—';
      tdOnline.className = 'muted';
    }
    for (const m of members) {
      const chip = document.createElement('span');
      chip.className = 'member';
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'member-remove';
      remove.textContent = '×';
      remove.title = `Remove ${m.name} from the room`;
      remove.setAttribute('aria-label', remove.title);
      remove.onclick = () => removeMember(r, m);
      chip.append(m.name, remove);
      tdOnline.append(chip);
    }
    const tdAct = document.createElement('td');
    const copy = button('Copy link', async () => {
      try {
        await navigator.clipboard.writeText(roomUrl(r.name));
        toast('Link copied');
      } catch {
        prompt('Room link', roomUrl(r.name));
      }
    });
    const pw = button('Password…', () => changePassword(r.name, !!r.drive));
    const drv = button('Drive…', () => changeDrive(r.name, r.drive, r.hasPassword));
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

/** Disconnect one person from a room. It does not keep them out: the password (or, for an open room, the link) still works. */
async function removeMember(room, m) {
  const after = room.hasPassword
    ? 'They can join again with the room password. To keep them out, change the password (that also ends their access to the room\'s Google Drive folder).'
    : 'This room has no password, so they can join again with its link. Give the room a password to keep them out.';
  if (!confirm(`Remove “${m.name}” from “${room.name}”?\n\n${after}`)) return;
  try {
    await api('DELETE', `/rooms/${encodeURIComponent(room.name)}/members/${encodeURIComponent(m.id)}`, {});
    toast(`${m.name} was removed from the room`);
  } catch (err) {
    toast(err.message);
  }
  refresh();
}

function button(label, onClick) {
  const b = document.createElement('button');
  b.className = 'btn';
  b.type = 'button';
  b.textContent = label;
  b.onclick = onClick;
  return b;
}

function changePassword(name, hasDrive) {
  const d = $('pw-dialog');
  $('pw-room').textContent = name;
  $('pw-new').value = '';
  $('pw-drive').hidden = !hasDrive; // a warning: without a password, anyone with the link can stream the folder
  $('pw-kick').checked = false;
  d.returnValue = 'cancel';
  d.showModal();
  d.addEventListener('close', async () => {
    if (d.returnValue !== 'save') return;
    try {
      await api('PUT', '/rooms/' + encodeURIComponent(name), { password: $('pw-new').value, kick: $('pw-kick').checked });
      if (hasDrive && !$('pw-new').value) toast(`Password removed. Anyone with the link to “${name}” can now stream its Google Drive folder.`, 10000, 'warn');
      else toast('Password updated');
    } catch (err) {
      toast(err.message);
    }
    refresh();
  }, { once: true });
}

function changeDrive(name, current, hasPassword) {
  const d = $('drive-dialog');
  $('drive-nopw').hidden = hasPassword;
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
      toast(`Folder “${check.name}” linked: ${check.items} items${check.truncated ? ' (very large: only the first part is listed)' : ''}`);
    }
    if (drive && !hasPassword) toast(`“${name}” has no password: anyone with its link can stream this folder.`, 10000, 'warn');
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
