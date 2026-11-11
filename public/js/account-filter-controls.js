(function() {
  'use strict';
  var shared = { year: '', month: '', companyId: '' };
  var timers = {}, requests = {}, companies = [], companyRequest;
  var renderers = {
    inv: 'renderInvoices', pay: 'renderPayments', pro: 'renderProforma', quo: 'renderQuotations',
    po: 'renderPO', clt: 'renderClients', ven: 'renderVendors', cwo: 'renderCWO',
    vwo: 'renderVWO', prj: 'renderProjects', tds: 'renderTdsRules', rep: 'renderReport'
  };
  function element(key, suffix) { return document.getElementById(key + '-' + suffix); }
  function value(key, suffix) { var input = element(key, suffix); return input ? input.value : ''; }
  function keys() { return Object.keys(renderers); }
  function refresh(key) {
    if (timers[key]) { clearTimeout(timers[key]); delete timers[key]; }
    if (typeof window[renderers[key]] === 'function') window[renderers[key]]();
  }
  function syncShared() {
    keys().forEach(function(key) {
      [['fy-year', shared.year], ['fy-month', shared.month], ['company-filter', shared.companyId]].forEach(function(pair) {
        var input = element(key, pair[0]);
        if (input) input.value = pair[1];
      });
      updatePeriod(key);
    });
  }
  function updatePeriod(key, count) {
    var period = AccountFilters.period(value(key, 'fy-year'), value(key, 'fy-month'));
    var button = element(key, 'fy-all');
    if (button) {
      button.classList.toggle('is-selected', !!period.all);
      button.setAttribute('aria-pressed', period.all ? 'true' : 'false');
      button.title = period.all ? 'Showing all financial years' : 'Clear the financial-year filter';
    }
    var meta = element(key, 'filter-meta');
    if (meta) {
      var companyId = value(key, 'company-filter');
      var company = companies.find(function(row) { return String(row.id) === companyId; });
      var parts = [];
      if (count !== undefined) parts.push(count + (count === 1 ? ' record' : ' records'));
      parts.push(period.valid ? period.label : period.error);
      if (company) parts.push(company.name);
      var section = key === 'rep' ? value('rep', 'section') : key;
      if (section === 'clt' || section === 'ven') parts.push('Based on registration date');
      else if (section === 'prj' || section === 'cwo' || section === 'vwo') parts.push('Based on start date (registration date if unset)');
      else if (section === 'tds') parts.push('Rules applicable during the selected period');
      meta.textContent = parts.join(' \u00b7 ');
      meta.classList.toggle('is-invalid', !period.valid);
    }
    return period;
  }
  window.readAccountFilters = function(key) {
    return {
      q: value(key, 'search'), status: value(key, 'status'), type: value(key, 'type'),
      sort: value(key, 'sort') || 'date_desc', companyId: value(key, 'company-filter'),
      year: value(key, 'fy-year'), month: value(key, 'fy-month'),
      section: value(key, 'section-filter'), payeeType: value(key, 'payee-filter')
    };
  };
  window.updateAccountFilterMeta = updatePeriod;
  window.validateAccountFilterYear = function(key) {
    var input = element(key, 'fy-year');
    if (!input) return true;
    var valid = !input.value || AccountFilters.validYear(input.value);
    input.setCustomValidity(valid ? '' : 'Enter a four-digit year (1000-9999).');
    input.setAttribute('aria-invalid', valid ? 'false' : 'true');
    updatePeriod(key);
    return valid;
  };
  window.changeAccountFilter = function(key, field) {
    if (field === 'period') { shared.year = value(key, 'fy-year'); shared.month = value(key, 'fy-month'); }
    if (field === 'company') shared.companyId = value(key, 'company-filter');
    if (field === 'period' || field === 'company') syncShared();
    validateAccountFilterYear(key);
    refresh(key);
  };
  window.clearAccountFinancialYear = function(key) {
    shared.year = ''; shared.month = '';
    syncShared();
    keys().forEach(window.validateAccountFilterYear);
    refresh(key);
  };
  window.scheduleAccountFilterRender = function(key) {
    if (timers[key]) clearTimeout(timers[key]);
    timers[key] = setTimeout(function() { refresh(key); }, 250);
  };
  window.applyAccountListFilters = function(key, rows, section, extras) {
    var filters = Object.assign(readAccountFilters(key), extras || {});
    var result = AccountFilters.filterAndSort(rows, section || key, filters);
    updatePeriod(key, result.length);
    return result;
  };
  window.accountListRequest = function(key, endpoint) {
    var request = (requests[key] || 0) + 1;
    requests[key] = request;
    return api('GET', endpoint).then(function(rows) {
      return requests[key] === request ? (rows || []) : null;
    });
  };
  window.initAccountListFilters = function() {
    keys().forEach(function(key) { updatePeriod(key); });
    if (!document.getElementById('inv-company-filter')) return Promise.resolve();
    if (!companyRequest) {
      companyRequest = api('GET', '/companies').then(function(rows) {
        companies = rows || [];
        keys().forEach(function(key) {
          var select = element(key, 'company-filter');
          if (!select) return;
          select.innerHTML = '<option value="">All Companies</option>';
          companies.forEach(function(company) {
            var option = document.createElement('option');
            option.value = String(company.id);
            option.textContent = company.name + (String(company.status).toLowerCase() === 'inactive' ? ' (Inactive)' : '');
            select.appendChild(option);
          });
        });
        syncShared();
      }).catch(function(error) { companyRequest = null; if (typeof toast === 'function') toast(error.message || 'Unable to load company filters', 'error'); });
    }
    return companyRequest;
  };
  document.addEventListener('DOMContentLoaded', function() { initAccountListFilters(); });
})();
