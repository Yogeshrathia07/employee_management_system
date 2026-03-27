// Shared logic for admin views when accessed by superadmin
// Adds company filter dropdown to header

var _isSuperAdmin = false;
var _allCompanies = [];
var _selectedCompanyId = '';

async function initCompanyFilter() {
  var user = getUser();
  if (!user) return;
  _isSuperAdmin = (user.role === 'superadmin');
  
  if (_isSuperAdmin) {
    // Replace sidebar with superadmin sidebar dynamically
    // Actually we need to detect at render time - let's use a simpler approach
    // Just load companies and add filter
    try {
      _allCompanies = await api('GET', '/companies');
    } catch(e) { _allCompanies = []; }
    
    // Check if company-filter container exists
    var container = document.getElementById('company-filter-container');
    if (container && _allCompanies.length) {
      container.innerHTML = '<select id="company-filter" class="form-control" style="width:200px;" onchange="onCompanyFilterChange()">' +
        '<option value="">All Companies</option>' +
        _allCompanies.map(function(c) { return '<option value="'+c.id+'">'+c.name+'</option>'; }).join('') +
        '</select>';
      container.style.display = '';
    }
  }
}

function getCompanyFilterParam() {
  if (!_isSuperAdmin) return '';
  var sel = document.getElementById('company-filter');
  if (sel && sel.value) return '&companyId=' + sel.value;
  return '';
}

function getSelectedCompanyId() {
  if (!_isSuperAdmin) return '';
  var sel = document.getElementById('company-filter');
  return sel ? sel.value : '';
}

// Override this in each page
function onCompanyFilterChange() {
  // Pages should override this
  if (typeof reloadPageData === 'function') reloadPageData();
}
