// ─── Auth Helpers ───
function getCookieValue(name) {
  var match = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : '';
}

const getToken = () => localStorage.getItem('ems_token') || getCookieValue('token');
const getUser = () => JSON.parse(localStorage.getItem('ems_user') || 'null');

// ─── Company dropdowns ───
// Company names can repeat (two companies may both be called "DHPE"), so every
// company list shows the GST number next to the name to tell them apart.
function companyOptionLabel(company) {
  if (!company) return '';
  var name = company.name || ('Company ' + company.id);
  return company.gstNo ? name + ' | GST: ' + company.gstNo : name;
}
function companyOptionHtml(company) {
  var esc = function (value) {
    return String(value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  };
  return '<option value="' + esc(company.id) + '">' + esc(companyOptionLabel(company)) + '</option>';
}

function setAuthCookie(token) {
  if (!token) return;
  var parts = ['token=' + encodeURIComponent(token), 'Path=/', 'SameSite=Lax'];
  if (window.location.protocol === 'https:') parts.push('Secure');
  document.cookie = parts.join('; ');
}

function clearAuthCookie() {
  var parts = ['token=', 'Path=/', 'Max-Age=0', 'SameSite=Lax'];
  if (window.location.protocol === 'https:') parts.push('Secure');
  document.cookie = parts.join('; ');
}

function syncStoredAuthCookie() {
  var token = getToken();
  if (token) setAuthCookie(token);
}

function setAuth(token, user) {
  localStorage.setItem('ems_token', token);
  localStorage.setItem('ems_user', JSON.stringify(user));
  setAuthCookie(token);
}

function clearAuth() {
  localStorage.removeItem('ems_token');
  localStorage.removeItem('ems_user');
  clearAuthCookie();
}

function logout() {
  clearAuth();
  window.location.href = '/login';
}

function updateCompanyBrand(user) {
  if (!user || !user.company) return;

  var companyName = user.company.name || '';
  var companyLogo = user.company.logoUrl || user.company.logo || '';
  var companyId = user.company.id;
  var navbarNameEl = document.getElementById('navbar-company-name');
  var navbarLogoWrap = document.getElementById('navbar-logo-wrap');

  var sidebarNameEl = document.getElementById('sidebar-company-name');
  if (sidebarNameEl && companyName) {
    sidebarNameEl.textContent = companyName;
  }
  if (navbarNameEl && companyName) {
    navbarNameEl.textContent = companyName;
  }

  var sidebarLogoEl = document.getElementById('sidebar-company-logo');
  if (sidebarLogoEl) {
    if (companyLogo && companyId) {
      sidebarLogoEl.innerHTML = '<img src="/api/companies/' + companyId + '/logo" style="width:100%;height:100%;object-fit:cover;border-radius:12px;" onerror="this.parentElement.innerHTML=\'<i class=&quot;bx bx-buildings&quot; style=&quot;color:white;font-size:20px;&quot;></i>\'">';
    } else {
      sidebarLogoEl.innerHTML = '<i class="bx bx-buildings" style="color:white;font-size:20px;"></i>';
    }
  }

  if (navbarLogoWrap) {
    if (companyLogo && companyId) {
      navbarLogoWrap.innerHTML = '<img src="/api/companies/' + companyId + '/logo" alt="Logo" onerror="this.parentElement.innerHTML=\'<i class=&quot;bx bx-buildings&quot;></i>\'">';
    } else {
      navbarLogoWrap.innerHTML = '<i class="bx bx-buildings"></i>';
    }
  }
}

function needsDocumentVerificationLock(user) {
  return !!(user && user.role === 'employee' && ['pending_docs', 'docs_submitted'].includes(user.verificationStatus));
}

function getDocumentLockPath(user) {
  if (!needsDocumentVerificationLock(user)) return '';
  return '/employee/documents';
}

function getRoleHomePath(user) {
  if (!user) return '/login';
  var paths = {
    superadmin: '/superadmin/dashboard',
    admin: '/admin/dashboard',
    manager: '/manager/dashboard',
    employee: '/employee/dashboard'
  };
  return getDocumentLockPath(user) || paths[user.role] || '/employee/dashboard';
}

async function refreshStoredUser() {
  var token = getToken();
  var storedUser = getUser();
  if (!token || !storedUser || window.location.pathname.includes('/login')) return;

  try {
    var freshUser = await api('GET', '/users/me');
    if (!freshUser) return;
    var mergedUser = {
      ...storedUser,
      ...freshUser,
      company: freshUser.company || storedUser.company
    };
    setAuth(token, mergedUser);
    updateCompanyBrand(mergedUser);
    enforceVerificationRedirect(mergedUser);
  } catch (e) {}
}

function enforceVerificationRedirect(user) {
  var lockPath = getDocumentLockPath(user);
  if (!lockPath) return;
  var currentPath = window.location.pathname;
  if (currentPath !== lockPath && currentPath !== '/login') {
    window.location.replace(lockPath);
  }
}

// ─── API Fetch Wrapper ───
async function api(method, path, body = null) {
  const token = getToken();
  if (!token) { window.location.href = '/login'; return; }

  const opts = {
    method,
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    }
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch('/api' + path, opts);
  if (res.status === 401) { clearAuth(); window.location.href = '/login'; return; }

  const data = await res.json();
  if (res.status === 403 && data && data.lockPath) {
    var user = getUser();
    if (user && user.role === 'employee') {
      user.verificationStatus = data.verificationStatus || user.verificationStatus || 'pending_docs';
      setAuth(token, user);
    }
    if (window.location.pathname !== data.lockPath) {
      window.location.replace(data.lockPath);
      return;
    }
  }
  if (!res.ok) throw new Error(data.message || 'Request failed');
  return data;
}

async function apiForm(method, path, formData) {
  const token = getToken();
  if (!token) { window.location.href = '/login'; return; }

  const res = await fetch('/api' + path, {
    method,
    credentials: 'same-origin',
    headers: {
      'Authorization': `Bearer ${token}`
    },
    body: formData
  });

  if (res.status === 401) { clearAuth(); window.location.href = '/login'; return; }

  const data = await res.json().catch(function() { return {}; });
  if (!res.ok) throw new Error(data.message || 'Request failed');
  return data;
}

// ─── Toast Notifications ───
function toast(message, type = 'info') {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  const icons = { success: '✅', error: '❌', info: 'ℹ️' };
  t.innerHTML = `<span>${icons[type] || '📢'}</span><span>${message}</span>`;
  container.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity 0.3s'; setTimeout(() => t.remove(), 300); }, 3000);
}

// ─── Badge Helpers ───
function statusBadge(status) {
  const map = {
    pending: 'badge-pending', approved: 'badge-approved', rejected: 'badge-rejected',
    draft: 'badge-draft', finalized: 'badge-finalized', paid: 'badge-paid',
    active: 'badge-active', inactive: 'badge-inactive'
  };
  return `<span class="badge ${map[status] || 'badge-draft'}">${status}</span>`;
}

function roleBadge(role) {
  return `<span class="badge badge-${role}">${role}</span>`;
}

// Currency formatter — reads company currency from stored user, defaults to INR
function fmtCurrency(n) {
  var user = getUser();
  var code = (user && user.company && user.company.currency) || 'INR';
  var num  = Number(n || 0);
  try {
    var parts = new Intl.NumberFormat(undefined, {
      style: 'currency', currency: code,
      minimumFractionDigits: 0, maximumFractionDigits: 0
    }).formatToParts(num);
    var html = '';
    parts.forEach(function(p) {
      if (p.type === 'currency') html += '<span style="font-weight:300;">' + p.value + '</span>';
      else html += p.value;
    });
    return html;
  } catch(e) {
    return '<span style="font-weight:300;">₹</span>' + num.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  }
}

// Currency formatter override for cleaner INR symbol rendering
function fmtCurrency(n) {
  var user = getUser();
  var code = (user && user.company && user.company.currency) || 'INR';
  var num  = Number(n || 0);

  if (code === 'INR') {
    return '<span style="font-family:Arial,sans-serif;font-weight:700;">₹</span>' +
      num.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  }

  try {
    var parts = new Intl.NumberFormat(undefined, {
      style: 'currency', currency: code,
      minimumFractionDigits: 0, maximumFractionDigits: 0
    }).formatToParts(num);
    var html = '';
    parts.forEach(function(p) {
      if (p.type === 'currency') html += '<span style="font-family:Arial,sans-serif;font-weight:700;">' + p.value + '</span>';
      else html += p.value;
    });
    return html;
  } catch (e) {
    return '<span style="font-family:Arial,sans-serif;font-weight:700;">₹</span>' +
      num.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  }
}

// List of supported currencies for dropdowns
var CURRENCY_LIST = [
  { code:'INR', name:'Indian Rupee (₹)' },
  { code:'USD', name:'US Dollar ($)' },
  { code:'EUR', name:'Euro (€)' },
  { code:'GBP', name:'British Pound (£)' },
  { code:'AED', name:'UAE Dirham (د.إ)' },
  { code:'SAR', name:'Saudi Riyal (﷼)' },
  { code:'AUD', name:'Australian Dollar (A$)' },
  { code:'CAD', name:'Canadian Dollar (C$)' },
  { code:'SGD', name:'Singapore Dollar (S$)' },
  { code:'MYR', name:'Malaysian Ringgit (RM)' },
  { code:'JPY', name:'Japanese Yen (¥)' },
  { code:'CNY', name:'Chinese Yuan (¥)' },
  { code:'KRW', name:'South Korean Won (₩)' },
  { code:'THB', name:'Thai Baht (฿)' },
  { code:'IDR', name:'Indonesian Rupiah (Rp)' },
  { code:'PHP', name:'Philippine Peso (₱)' },
  { code:'PKR', name:'Pakistani Rupee (₨)' },
  { code:'BDT', name:'Bangladeshi Taka (৳)' },
  { code:'NPR', name:'Nepalese Rupee (रू)' },
  { code:'LKR', name:'Sri Lankan Rupee (රු)' },
  { code:'CHF', name:'Swiss Franc (Fr)' },
  { code:'ZAR', name:'South African Rand (R)' },
  { code:'BRL', name:'Brazilian Real (R$)' },
  { code:'MXN', name:'Mexican Peso ($)' },
  { code:'NGN', name:'Nigerian Naira (₦)' },
  { code:'GHS', name:'Ghanaian Cedi (₵)' },
  { code:'KES', name:'Kenyan Shilling (KSh)' },
  { code:'QAR', name:'Qatari Riyal (﷼)' },
  { code:'KWD', name:'Kuwaiti Dinar (KD)' },
  { code:'BHD', name:'Bahraini Dinar (BD)' },
  { code:'OMR', name:'Omani Rial (ر.ع.)' },
  { code:'TRY', name:'Turkish Lira (₺)' },
  { code:'RUB', name:'Russian Ruble (₽)' },
  { code:'SEK', name:'Swedish Krona (kr)' },
  { code:'NOK', name:'Norwegian Krone (kr)' },
  { code:'DKK', name:'Danish Krone (kr)' },
  { code:'NZD', name:'New Zealand Dollar (NZ$)' },
  { code:'HKD', name:'Hong Kong Dollar (HK$)' },
];

// Profile photo helper — returns img tag or initials div
function userAvatar(user, size) {
  size = size || 36;
  var fs = size < 30 ? 11 : size < 44 ? 14 : size < 60 ? 18 : 24;
  var name = (user && user.name) ? user.name : 'U';
  var initial = name.charAt(0).toUpperCase();
  var initialsHtml = '<div style="width:'+size+'px;height:'+size+'px;border-radius:50%;background:linear-gradient(135deg,#1f2937,#334155);display:flex;align-items:center;justify-content:center;font-size:'+fs+'px;font-weight:700;color:white;flex-shrink:0;">'+initial+'</div>';
  
  // Only show img if profilePhoto is a non-empty string
  if (user && user.profilePhoto && user.profilePhoto.length > 0) {
    return '<div style="width:'+size+'px;height:'+size+'px;border-radius:50%;overflow:hidden;flex-shrink:0;position:relative;">' +
      '<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:'+fs+'px;font-weight:700;color:white;background:linear-gradient(135deg,#1f2937,#334155);">'+initial+'</div>' +
      '<img src="/api/users/'+user.id+'/photo" style="position:relative;z-index:1;width:100%;height:100%;object-fit:cover;display:block;" onload="this.previousElementSibling.style.display=\'none\'" onerror="this.style.display=\'none\'">' +
    '</div>';
  }
  return initialsHtml;
}

// Simple initials avatar (no photo)
function initialsAvatar(name, size) {
  size = size || 36;
  var fs = size < 30 ? 11 : size < 44 ? 14 : 18;
  return '<div style="width:'+size+'px;height:'+size+'px;border-radius:50%;background:linear-gradient(135deg,#1f2937,#334155);display:flex;align-items:center;justify-content:center;font-size:'+fs+'px;font-weight:700;color:white;flex-shrink:0;">'+((name||'U').charAt(0))+'</div>';
}

// ─── Date Formatting ───
function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' });
}

function fmtDateTime(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-US', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function monthName(m) {
  return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m-1] || '';
}

// ─── Modal Helpers ───
function openModal(id) {
  const el = document.getElementById(id);
  if (el) {
    el.classList.add('show');
    document.body.classList.add('modal-open');
  }
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('show');
  if (!document.querySelector('.modal-overlay.show')) {
    document.body.classList.remove('modal-open');
  }
}

// Close modal on overlay click
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('modal-overlay')) {
    e.target.classList.remove('show');
    if (!document.querySelector('.modal-overlay.show')) {
      document.body.classList.remove('modal-open');
    }
  }
});

// Close modal on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay.show').forEach(m => m.classList.remove('show'));
    document.body.classList.remove('modal-open');
  }
});

// Keep the drawer state and native link navigation consistent on every page.
var sidebarNavigationBound = false;
var sidebarPreviousOverflow = null;
var sidebarReturnFocus = null;
function setSidebarOpen(open) {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebarOverlay');
  if (!sidebar) return;
  const mobile = window.matchMedia('(max-width: 900px)').matches;
  open = !!open && mobile;
  const wasOpen = sidebar.classList.contains('open');
  // Lock scrolling on the first open seen here. A menu opened by the stand-in in head.ejs
  // before this script loaded is already "open" but has not locked scrolling yet.
  if (open && sidebarPreviousOverflow === null) {
    sidebarPreviousOverflow = document.body.style.overflow;
    sidebarReturnFocus = document.activeElement;
  }
  sidebar.classList.toggle('open', open);
  sidebar.setAttribute('aria-hidden', mobile && !open ? 'true' : 'false');
  sidebar.inert = mobile && !open;
  if (overlay) {
    overlay.classList.toggle('show', open);
    overlay.setAttribute('aria-hidden', open ? 'false' : 'true');
  }
  document.querySelectorAll('.mobile-menu-btn').forEach(button => {
    button.setAttribute('aria-controls', 'sidebar');
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (!button.hasAttribute('aria-label')) button.setAttribute('aria-label', 'Open navigation menu');
  });
  if (open) document.body.style.overflow = 'hidden';
  else if (sidebarPreviousOverflow !== null) {
    document.body.style.overflow = sidebarPreviousOverflow;
    sidebarPreviousOverflow = null;
  }
  if (!open && wasOpen && sidebar.contains(document.activeElement) && sidebarReturnFocus && sidebarReturnFocus.isConnected) sidebarReturnFocus.focus({ preventScroll: true });
}
function openSidebar() { setSidebarOpen(true); }
function closeSidebar() { setSidebarOpen(false); }
function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  setSidebarOpen(sidebar && !sidebar.classList.contains('open'));
}
function initSidebarNavigation() {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;
  const currentPath = window.location.pathname.replace(/\/+$/, '') || '/';
  let activeLink = null;
  let longestMatch = -1;
  sidebar.querySelectorAll('.nav-link[href]').forEach(link => {
    link.classList.remove('active');
    link.removeAttribute('aria-current');
    const target = new URL(link.getAttribute('href'), window.location.origin);
    const pathname = target.pathname.replace(/\/+$/, '') || '/';
    if (target.origin === window.location.origin &&
        (currentPath === pathname || (pathname !== '/' && currentPath.startsWith(pathname + '/'))) &&
        pathname.length > longestMatch) {
      activeLink = link;
      longestMatch = pathname.length;
    }
  });
  if (activeLink) {
    activeLink.classList.add('active');
    activeLink.setAttribute('aria-current', 'page');
  }
  setSidebarOpen(sidebar.classList.contains('open'));
  if (sidebarNavigationBound) return;
  sidebarNavigationBound = true;
  document.addEventListener('click', event => {
    const link = event.target.closest && event.target.closest('#sidebar .nav-link[href]');
    if (link && event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && link.target !== '_blank') closeSidebar();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && document.getElementById('sidebar')?.classList.contains('open')) closeSidebar();
  });
  window.addEventListener('resize', () => {
    const current = document.getElementById('sidebar');
    if (current) setSidebarOpen(current.classList.contains('open'));
  });
}

// ─── apiFetch (alias for fetch with auth) ───
async function apiFetch(url, opts = {}) {
  if (opts.credentials === undefined) opts.credentials = 'same-origin';
  opts.headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const res = await fetch(url, opts);
  const data = await res.json();
  if (res.status === 403 && data && data.lockPath) {
    if (window.location.pathname !== data.lockPath) {
      window.location.replace(data.lockPath);
      return;
    }
  }
  if (!res.ok) throw new Error(data.message || 'Request failed');
  return data;
}

// ─── Auth Guard ───
syncStoredAuthCookie();

(function() {
  const token = getToken();
  const user = getUser();
  if (!token) {
    if (!window.location.pathname.includes('/login')) {
      window.location.href = '/login';
    }
    return;
  }

  if (!user) {
    fetch('/api/users/me', {
      credentials: 'same-origin',
      headers: { 'Authorization': 'Bearer ' + token }
    })
      .then(function(res) {
        if (!res.ok) throw new Error('Session expired');
        return res.json();
      })
      .then(function(freshUser) {
        setAuth(token, freshUser);
        if (window.location.pathname.includes('/login')) {
          window.location.href = getRoleHomePath(freshUser);
          return;
        }
        updateCompanyBrand(freshUser);
        enforceVerificationRedirect(freshUser);
        refreshStoredUser();
      })
      .catch(function() {
        clearAuth();
        if (!window.location.pathname.includes('/login')) {
          window.location.href = '/login';
        }
      });
    return;
  }

  enforceVerificationRedirect(user);

  // Set company name in sidebar
  var companyNameEl = document.getElementById('sidebar-company-name');
  if (companyNameEl && user.company && user.company.name) {
    companyNameEl.textContent = user.company.name;
  }

  // Load company logo if exists
  if (user.company && user.company.logoUrl && user.company.logoUrl.length > 0) {
    var logoEl = document.getElementById('sidebar-company-logo');
    if (logoEl) {
      var logoSrc = user.company.logoUrl.startsWith('http') ? user.company.logoUrl : '/api/companies/' + user.company.id + '/logo';
      var img = document.createElement('img');
      img.src = logoSrc;
      img.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:12px;';
      img.onerror = function() {
        this.parentElement.innerHTML = '<i class="bx bx-buildings" style="color:white;font-size:20px;"></i>';
      };
      logoEl.innerHTML = '';
      logoEl.appendChild(img);
    }
  }

  updateCompanyBrand(user);
  refreshStoredUser();

  // Logout button
  document.getElementById('logout-btn')?.addEventListener('click', logout);

})();
initSidebarNavigation();
