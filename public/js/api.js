// ─── Auth Helpers ───
const getToken = () => localStorage.getItem('ems_token');
const getUser = () => JSON.parse(localStorage.getItem('ems_user') || 'null');

function setAuth(token, user) {
  localStorage.setItem('ems_token', token);
  localStorage.setItem('ems_user', JSON.stringify(user));
}

function clearAuth() {
  localStorage.removeItem('ems_token');
  localStorage.removeItem('ems_user');
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

// ─── Mobile Sidebar Toggle ───
function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebarOverlay');
  if (sidebar) sidebar.classList.toggle('open');
  if (overlay) overlay.classList.toggle('show');
}

function closeSidebar() {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebarOverlay');
  if (sidebar) sidebar.classList.remove('open');
  if (overlay) overlay.classList.remove('show');
  document.body.style.overflow = '';
}

// ─── apiFetch (alias for fetch with auth) ───
async function apiFetch(url, opts = {}) {
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
(function() {
  const token = getToken();
  const user = getUser();
  if (!token || !user) {
    if (!window.location.pathname.includes('/login')) {
      window.location.href = '/login';
    }
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

  // Mark active nav link + close sidebar on mobile when link clicked
  document.querySelectorAll('.nav-link').forEach(link => {
    const href = link.getAttribute('href');
    if (href && window.location.pathname.startsWith(href) && href !== '/') {
      link.classList.add('active');
    } else if (href === window.location.pathname) {
      link.classList.add('active');
    }
    link.addEventListener('click', () => {
      if (window.innerWidth <= 900) closeSidebar();
    });
  });
})();
