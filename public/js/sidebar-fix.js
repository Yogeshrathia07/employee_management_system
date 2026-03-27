// If superadmin is viewing admin pages, update sidebar to show superadmin nav
(function() {
  var user = getUser();
  if (!user || user.role !== 'superadmin') return;
  
  var sidebar = document.getElementById('sidebar');
  if (!sidebar) return;
  
  // Update company branding area
  var companyNameEl = document.getElementById('sidebar-company-name');
  if (companyNameEl) companyNameEl.textContent = 'EMS Platform';
  
  // Replace nav links with superadmin navigation
  var nav = sidebar.querySelector('nav');
  if (nav) {
    var currentPath = window.location.pathname;
    var links = [
      {href:'/superadmin/dashboard', icon:'bxs-dashboard', label:'Dashboard', section:'Main'},
      {href:'/superadmin/companies', icon:'bxs-buildings', label:'Companies', section:'Management'},
      {href:'/superadmin/users', icon:'bxs-group', label:'All Users'},
      {href:'/admin/leaves', icon:'bxs-calendar-check', label:'All Leaves', section:'Company Data'},
      {href:'/admin/timesheets', icon:'bxs-time-five', label:'All Timesheets'},
      {href:'/admin/salary', icon:'bxs-wallet', label:'All Payroll'},
      {href:'/admin/documents', icon:'bxs-file-doc', label:'All Documents'},
      {href:'/superadmin/recycle-bin', icon:'bxs-trash', label:'Recycle Bin', section:'System'},
    ];
    
    var html = '';
    var lastSection = '';
    links.forEach(function(l) {
      if (l.section && l.section !== lastSection) {
        html += '<div style="padding:' + (lastSection ? '16' : '12') + 'px 12px 6px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1.2px;color:var(--text-muted);">' + l.section + '</div>';
        lastSection = l.section;
      }
      var active = currentPath === l.href ? ' active' : '';
      html += '<a href="' + l.href + '" class="nav-link' + active + '"><span class="nav-icon"><i class="bx ' + l.icon + '"></i></span> ' + l.label + '</a>';
    });
    nav.innerHTML = html;
  }
  
})();
