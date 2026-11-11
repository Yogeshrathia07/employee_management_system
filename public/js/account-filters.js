(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AccountFilters = factory();
})(typeof window !== 'undefined' ? window : this, function() {
  'use strict';

  var configs = {
    inv: { date: ['invoiceDate'], name: ['customerName'], reference: ['invoiceNumber'], amount: 'totalAmount' },
    pay: { date: ['paymentDate'], name: ['partyName'], reference: ['paymentNumber'], amount: 'netAmount', type: 'paymentType' },
    pro: { date: ['date'], name: ['customerName'], reference: ['proformaNumber'], amount: 'totalAmount' },
    quo: { date: ['date'], name: ['clientName', 'client.name'], reference: ['quotationNumber'], amount: 'totalAmount' },
    po: { date: ['date'], name: ['vendorName', 'vendor.name'], reference: ['poNumber'], amount: 'totalAmount' },
    clt: { date: ['createdAt'], name: ['name'], reference: ['clientCode'] },
    ven: { date: ['createdAt'], name: ['name'], reference: ['vendorCode'] },
    cwo: { date: ['startDate', 'createdAt'], name: ['partyName', 'client.name'], reference: ['woNumber'], amount: 'totalAmount' },
    vwo: { date: ['startDate', 'createdAt'], name: ['partyName', 'vendor.name'], reference: ['woNumber'], amount: 'totalAmount' },
    prj: { date: ['startDate', 'createdAt'], name: ['name'], reference: ['projectCode'], amount: 'budget' },
    tds: { date: ['applicableFrom'], name: ['nature'], reference: ['code'], rate: 'rate', applicability: true }
  };

  function valueAt(row, path) {
    return path.split('.').reduce(function(value, key) { return value == null ? undefined : value[key]; }, row);
  }
  function first(row, fields) {
    for (var i = 0; i < fields.length; i++) {
      var value = valueAt(row, fields[i]);
      if (value !== undefined && value !== null && value !== '') return value;
    }
    return '';
  }
  function dateValue(row, config) {
    var value = String(first(row, config.date) || '');
    var match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return match ? match[0] : '';
  }
  function validYear(value) {
    return /^\d{4}$/.test(String(value)) && Number(value) >= 1000 && Number(value) <= 9999;
  }
  function period(year, month) {
    year = String(year || '').trim();
    month = String(month || '').trim();
    if (!year && !month) return { valid: true, all: true, label: 'All financial years' };
    if (!validYear(year)) return { valid: false, all: false, error: 'Enter a four-digit year (1000-9999).' };
    if (month && !/^(0[1-9]|1[0-2])$/.test(month)) return { valid: false, all: false, error: 'Choose a valid month.' };
    var start = Number(year) - (month && Number(month) < 4 ? 1 : 0);
    var padded = String(start).padStart(4, '0');
    return {
      valid: true, all: false, label: 'FY ' + padded + '-' + (start + 1),
      code: padded.slice(-2) + '-' + String(start + 1).slice(-2),
      from: start < 1000 ? '1000-01-01' : padded + '-04-01',
      to: start === 9999 ? '9999-12-31' : String(start + 1).padStart(4, '0') + '-03-31'
    };
  }
  function matchesInvoiceType(row, type) {
    if (!type) return true;
    var parts = type.split(':');
    return (row.documentType || 'Tax Invoice') === parts[0] && (!parts[1] || (row.invoiceType || 'B2B') === parts[1]);
  }
  function filterAndSort(rows, key, filters) {
    var config = configs[key];
    if (!config) return [];
    filters = filters || {};
    var fy = period(filters.year, filters.month);
    if (!fy.valid) return [];
    var from = [fy.all ? '' : fy.from, filters.from || ''].sort().pop();
    var until = [fy.all ? '' : fy.to, filters.to || ''].filter(Boolean).sort()[0] || '';
    if (from && until && from > until) return [];
    var query = String(filters.q || '').trim().toLocaleLowerCase();
    var searchFields = config.name.concat(config.reference, [
      'email', 'phone', 'contactPerson', 'gstin', 'customerGstin', 'partyGstin', 'partyPan', 'category',
      'state', 'projectName', 'projectCode', 'projectAccount.name', 'projectAccount.projectCode',
      'clientName', 'vendorName', 'referenceNo', 'invoiceNumber', 'invoice.invoiceNumber', 'workOrder',
      'section', 'payeeType', 'conditionNote'
    ]);
    var result = (Array.isArray(rows) ? rows : []).filter(function(row) {
      if (filters.companyId && String(row.companyId || (row.company && row.company.id) || '') !== String(filters.companyId)) return false;
      var status = config.applicability ? ([false, 0, '0', 'false'].includes(row.active) ? 'inactive' : 'active') : String(row.status || '').toLowerCase();
      if (filters.status && status !== String(filters.status).toLowerCase()) return false;
      if (config.applicability && filters.section && String(row.section || '').toLowerCase() !== String(filters.section).toLowerCase()) return false;
      if (config.applicability && filters.payeeType && String(row.payeeType || '').toLowerCase() !== String(filters.payeeType).toLowerCase()) return false;
      if (filters.type && (key === 'inv' ? !matchesInvoiceType(row, filters.type) : row[config.type] !== filters.type)) return false;
      if (query && !searchFields.some(function(field) { return String(valueAt(row, field) || '').toLocaleLowerCase().includes(query); })) return false;
      if (config.applicability) {
        if (until && row.applicableFrom && row.applicableFrom > until) return false;
        if (from && row.applicableTo && row.applicableTo < from) return false;
      } else {
        var date = dateValue(row, config);
        if (from && (!date || date < from)) return false;
        if (until && (!date || date > until)) return false;
      }
      return true;
    });
    var sort = String(filters.sort || 'date_desc');
    var descending = sort.endsWith('_desc');
    var field = sort.slice(0, sort.lastIndexOf('_'));
    return result.sort(function(a, b) {
      var left, right;
      if (field === 'amount' && config.amount) { left = Number(a[config.amount] || 0); right = Number(b[config.amount] || 0); }
      else if (field === 'rate' && config.rate) { left = Number(a[config.rate] || 0); right = Number(b[config.rate] || 0); }
      else if (field === 'customer' || field === 'name') { left = first(a, config.name); right = first(b, config.name); }
      else if (field === 'reference') { left = first(a, config.reference); right = first(b, config.reference); }
      else { left = dateValue(a, config); right = dateValue(b, config); }
      if (left === '' && right !== '') return 1;
      if (right === '' && left !== '') return -1;
      var compared = typeof left === 'number' ? left - right
        : String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: 'base' });
      return compared ? compared * (descending ? -1 : 1) : Number(a.id || 0) - Number(b.id || 0);
    });
  }
  return { configs: configs, validYear: validYear, period: period, filterAndSort: filterAndSort, dateValue: dateValue };
});
