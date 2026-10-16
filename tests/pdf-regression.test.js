'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { finished } = require('node:stream/promises');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const PDFKit = require('pdfkit');
const { PDFDocument } = require('pdf-lib');
const models = require('../models');
const scope = require('../controllers/accountsCompanyScope');
const helper = require('../controllers/pdfHelper');
const projectController = require('../controllers/projectAccountController');
const poController = require('../controllers/purchaseOrderController');

const company = {
  id: 2, name: 'ESSPEE CONSTRUCTION & SERVICES', address: '182 Example Road\nKolkata, West Bengal, India',
  phone: '9000000000', email: 'accounts@example.test', state: 'West Bengal', stateCode: '19',
  bankName: 'Example Bank', bankAccount: '000000000001', bankIfsc: 'TEST0000001',
  bankAcName: 'Example Construction and Civil Engineering Services Company',
  bankBranch: 'Commercial Centre, Block 41, Newtown Business District, Kolkata, West Bengal, India, 700156',
};
const otherCompany = { ...company, id: 1, name: 'OTHER COMPANY' };
const longName = 'Repairing of footpaths considering upcoming festivals by resetting existing blocks and concreting from the railway station to the main road, including drainage and all associated civil engineering works.';
const description = [
  'Tender Reference Number: TEST/AE/BKPSD-I/NIeT-20/26-27', 'Tender No: 28/TEST-1 of 2026-27.',
  'Issuing Authority: Assistant Engineer, Public Works Department, Sub-Division-I.',
  'Work Order Memo No.: 949, Date: 29.09.2026', 'Estimated Amount: 4,64,641.00',
  'Accepted Amount: @0.750% Less', 'Tendered Amount: 4,61,156.00', 'MB No: 6977',
  'Security Deposit Up to Date: 12.10.2026',
].join('\n');

function record(values) {
  return { ...values, toJSON() { const { toJSON, update, ...plain } = this; return { ...plain }; },
    async update(updates) { Object.assign(this, updates); return this; } };
}
function project(overrides = {}) {
  return record({ id: 12, companyId: 2, company, projectCode: 'PRJ-REGRESSION', name: longName,
    clientName: 'PUBLIC WORKS DEPARTMENT - NORTH DISTRICT', startDate: '2026-09-30', endDate: '2026-10-15',
    budget: 461156, status: 'Completed', description, purchaseOrders: [], invoices: [], workOrders: [], ...overrides });
}
function account(overrides = {}) {
  const items = Array.from({ length: 28 }, (_, index) => ({
    name: `Item ${index + 1}: ${longName}`, description: longName, itemCode: `C${index + 1}`,
    hsnCode: '9954', unit: 'Nos.', quantity: 2, qty: 2, unitPrice: 100, rate: 100, taxRate: 18,
    taxableAmount: 200, cgst: 18, sgst: 18, igst: 0, taxAmount: 36, itemTotal: 236,
  }));
  return record({ id: 13, companyId: 2, company, createdBy: 1,
    invoiceNumber: 'INV-REGRESSION', proformaNumber: 'PRO-REGRESSION', quotationNumber: 'QUO-REGRESSION',
    poNumber: 'PO-REGRESSION', woNumber: 'WO-REGRESSION',
    sellerName: company.name, sellerAddress: company.address, sellerPhone: company.phone,
    sellerEmail: company.email, sellerState: 'West Bengal', sellerStateCode: '19',
    customerName: 'PUBLIC WORKS DEPARTMENT', customerAddress: 'Example Customer Road\nKolkata, India',
    customerState: 'West Bengal', customerStateCode: '19', bankName: company.bankName,
    bankAcName: company.bankAcName, bankBranch: company.bankBranch,
    bankAccount: company.bankAccount, bankIfsc: company.bankIfsc,
    date: '2026-10-15', invoiceDate: '2026-10-15', status: 'Draft', items,
    subtotal: 5600, totalCgst: 504, totalSgst: 504, totalIgst: 0, totalTax: 1008, totalAmount: 6608,
    projectName: longName, projectCode: 'PRJ-REGRESSION', workOrder: 'WO-REGRESSION',
    showTaxPercentInPdf: true, roundOffMode: 'none', notes: description,
    termsConditions: 'All work must meet the agreed specification and completion schedule.',
    vendorName: 'Example Supplier', vendor: { name: 'Example Supplier', address: 'Example Vendor Road, Kolkata' },
    client: { name: 'Example Customer', address: 'Example Customer Road, Kolkata' },
    type: 'CWO', startDate: '2026-10-01', endDate: '2026-10-31', scope: description,
    milestones: Array.from({ length: 30 }, (_, i) => ({ title: `Milestone ${i + 1}: ${longName}`, dueDate: '2026-10-31', amount: 1000, status: 'Pending' })),
    ...overrides });
}

async function generate(t, name, handler, req = {}) {
  const calls = [];
  const originalText = PDFKit.prototype.text;
  t.mock.method(PDFKit.prototype, 'text', function (value, x, y, options) {
    const opts = options || (typeof x === 'object' ? x : {});
    const text = String(value ?? '');
    calls.push({ text, x: typeof x === 'number' ? x : this.x,
      y: typeof y === 'number' ? y : this.y, width: opts.width, page: this.page,
      // A height limit (used with ellipsis) caps how much of the text is drawn.
      height: Math.min(this.heightOfString(text, opts), opts.height ?? Infinity),
      // A number wider than its box would be broken across lines.
      splitNumber: opts.width
        ? text.split(/\s+/).find(token => /^[\d.,%]+$/.test(token) && this.widthOfString(token) > opts.width + 0.01)
        : undefined });
    return originalText.apply(this, arguments);
  });
  const response = new PassThrough();
  response.statusCode = 200;
  response.headers = {};
  response.setHeader = (key, value) => { response.headers[key] = value; };
  response.status = code => { response.statusCode = code; return response; };
  response.json = body => { response.errorBody = body; response.end(JSON.stringify(body)); };
  const chunks = [];
  response.on('data', chunk => chunks.push(chunk));
  const complete = finished(response);
  await handler({ user: { id: 1, role: 'superadmin' }, params: { id: 12 }, query: {}, body: {}, ...req }, response);
  await complete;
  assert.equal(response.statusCode, 200, JSON.stringify(response.errorBody));
  const bytes = Buffer.concat(chunks);
  const pdf = await PDFDocument.load(bytes);
  assert.ok(pdf.getPageCount() > 0);
  assert.equal(response.headers['Content-Type'], 'application/pdf');
  const footers = calls.filter(call => call.text.startsWith('Note: This document is'));
  const isSalary = name.startsWith('salary');
  if (!isSalary) {
    assert.equal(footers.length, pdf.getPageCount(), `${name}: footer on every page`);
    assert.ok(footers.every(call => call.text.includes(company.name)), `${name}: selected company in footer`);
    assert.ok(calls.every(call => !call.text.includes('property of DHPE')), `${name}: no hard-coded company`);
  }
  for (const call of calls) {
    if (!call.text.trim()) continue;
    assert.ok(call.x >= 0 && call.y >= 0, `${name}: text begins inside page: ${call.text.slice(0, 55)}`);
    assert.ok(call.y + call.height < call.page.height + 1, `${name}: text exceeds page: ${call.text.slice(0, 55)}`);
    assert.ok(!call.splitNumber, `${name}: number split across lines: ${call.splitNumber}`);
    const footerTop = call.page.height - helper.M - helper.FOOTER_H;
    if (!isSalary && call.y < footerTop) {
      assert.ok(call.y + call.height <= footerTop + 0.5, `${name}: text runs into the footer: ${call.text.slice(0, 55)}`);
    }
  }
  if (process.env.PDF_QA_OUTPUT) {
    fs.mkdirSync(process.env.PDF_QA_OUTPUT, { recursive: true });
    fs.writeFileSync(path.join(process.env.PDF_QA_OUTPUT, name + '.pdf'), bytes);
  }
  return { calls, pdf };
}

test('company selection honors superadmin choice and validates company IDs', async t => {
  t.mock.method(models.Company, 'findByPk', async id => Number(id) === 2 ? company : Number(id) === 1 ? otherCompany : null);
  assert.equal(await scope.resolveAccountCompanyId({ user: { role: 'superadmin' } }, { companyId: 2 }, [1]), 2);
  assert.equal(await scope.resolveAccountCompanyId({ user: { role: 'admin', companyId: 1 } }, { companyId: 2 }), 1);
  await assert.rejects(scope.resolveAccountCompanyId({ user: { role: 'admin' } }, { companyId: 2 }), /Admin company/);
  await assert.rejects(scope.resolveAccountCompanyId({ user: { role: 'superadmin' } }, { companyId: 999 }), /valid company/);
  await assert.rejects(scope.resolveAccountCompanyId({ user: { role: 'superadmin' } }, { companyId: 'invalid' }), /valid company/);
});
test('admin cannot read another company project', async () => {
  const result = await scope.ensureCompanyAccess({ user: { role: 'admin', companyId: 1 } }, 'projectAccount', project());
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
});
for (const [label, controller, model, createMethod, updateMethod] of [
  ['project', projectController, models.ProjectAccount, 'createProjectAccount', 'updateProjectAccount'],
  ['purchase order', poController, models.PurchaseOrder, 'createPurchaseOrder', 'updatePurchaseOrder'],
]) {
  test(`${label} create and edit persist selected company over relation defaults`, async t => {
    t.mock.method(models.Company, 'findByPk', async id => Number(id) === 2 ? company : otherCompany);
    t.mock.method(models.Client, 'findByPk', async () => record({ id: 10, name: 'Client', companyId: 1 }));
    t.mock.method(models.Vendor, 'findByPk', async () => record({ id: 10, name: 'Vendor', companyId: 1 }));
    const existing = record({ id: 12, companyId: 1 });
    t.mock.method(model, 'findByPk', async () => existing);
    let created;
    t.mock.method(model, 'create', async data => { created = data; return record(data); });
    const response = { status() { return this; }, json(body) { this.body = body; } };
    const req = { user: { id: 1, role: 'superadmin' }, params: { id: 12 }, body: {
      name: 'Project', companyId: 2, clientId: 10, vendorId: 10, date: '2026-10-15' } };
    await controller[createMethod](req, response);
    assert.equal(created.companyId, 2);
    await controller[updateMethod](req, response);
    assert.equal(existing.companyId, 2);
  });
}
test('project PDF grows rows, preserves description, displays zero counts, and wraps bank details', async t => {
  t.mock.method(models.ProjectAccount, 'findByPk', async () => project());
  const { calls, pdf } = await generate(t, 'project', projectController.generatePDF);
  assert.equal(pdf.getPageCount(), 1);
  const name = calls.find(call => call.text === longName);
  const client = calls.find(call => call.text === 'Client');
  assert.ok(name.y + name.height <= client.y);
  const desc = calls.find(call => call.text === description);
  const linked = calls.find(call => call.text === 'Linked Records Summary');
  assert.ok(desc.y + desc.height <= linked.y);
  assert.equal(calls.filter(call => call.text === '0').length, 3);
  assert.ok(calls.find(call => call.text.startsWith('Branch:')).height > 10);
});
test('multi-page project description retains its final line before linked records', async t => {
  t.mock.method(models.ProjectAccount, 'findByPk', async () => project({ description: description.repeat(18) + '\nEND-OF-DESCRIPTION' }));
  const { calls, pdf } = await generate(t, 'project-long', projectController.generatePDF);
  assert.ok(pdf.getPageCount() >= 3);
  const end = calls.findIndex(call => call.text.includes('END-OF-DESCRIPTION'));
  assert.ok(end >= 0 && calls.findIndex(call => call.text === 'Linked Records Summary') > end);
});
for (const [name, moduleName, method, model] of [
  ['invoice', 'invoiceController', 'downloadPDF', 'Invoice'],
  ['invoice-landscape', 'invoiceController', 'downloadPDF', 'Invoice'],
  ['proforma', 'proformaDbController', 'generatePDF', 'Proforma'],
  ['quotation', 'quotationController', 'generatePDF', 'Quotation'],
  ['purchase-order', 'purchaseOrderController', 'generatePDF', 'PurchaseOrder'],
  ['work-order', 'workOrderController', 'generatePDF', 'WorkOrder'],
]) {
  test(`${name} renders long fields and multi-page tables with company-specific footers`, async t => {
    t.mock.method(models[model], 'findByPk', async () => account());
    const result = await generate(t, name, require('../controllers/' + moduleName)[method], {
      query: { orientation: name.includes('landscape') ? 'landscape' : 'portrait' } });
    assert.ok(result.pdf.getPageCount() >= 2);
    if (name.includes('landscape')) assert.ok(result.pdf.getPage(0).getWidth() > result.pdf.getPage(0).getHeight());
    if (name === 'purchase-order') assert.ok(result.calls.filter(call => call.text === 'Description').length >= 2);
    if (name === 'work-order') assert.ok(result.calls.filter(call => call.text === 'Milestone').length >= 2);
  });
}
test('invoice supports remarks longer than a page without losing its last line', async t => {
  t.mock.method(models.Invoice, 'findByPk', async () => account({ items: [], notes: description.repeat(20) + '\nEND-OF-REMARKS' }));
  const { calls } = await generate(t, 'invoice-long-remarks', require('../controllers/invoiceController').downloadPDF);
  assert.ok(calls.some(call => call.text.includes('END-OF-REMARKS')));
});
test('ad-hoc proforma uses the same company footer and long bank/terms layout', async t => {
  await generate(t, 'proforma-preview', require('../controllers/proformaController').generatePDF, {
    body: account({ paymentTerms: description, deliveryTimeline: longName }) });
});
test('payment PDF retains the invoice company identity', async t => {
  t.mock.method(models.Payment, 'findByPk', async () => record({ id: 1, companyId: 2, invoiceId: 13,
    paymentNumber: 'PAY-REGRESSION', paymentType: 'bill', financialYear: '26-27', paymentDate: '2026-10-15',
    partyName: 'PUBLIC WORKS DEPARTMENT', grossAmount: 5600, gstRate: 18, gstAmount: 1008, netAmount: 6608, notes: description }));
  t.mock.method(models.Invoice, 'findByPk', async () => account());
  t.mock.method(models.Company, 'findByPk', async () => company);
  t.mock.method(models.Payment, 'findAll', async () => []);
  await generate(t, 'payment', require('../controllers/paymentController').generatePDF);
});
test('salary slip keeps multi-line address above title', async t => {
  t.mock.method(models.Salary, 'findByPk', async () => record({ id: 1, companyId: 2, company, month: 10,
    year: 2026, userId: 5, basicSalary: 3000, hra: 1500, conveyance: 2700, specialAllowance: 3700,
    bonus: 2500, totalDays: 31, workedDays: 31, allowedLeave: 2, status: 'finalized',
    user: { id: 5, companyId: 2, name: 'Example Employee', email: 'employee@example.test', role: 'employee' } }));
  t.mock.method(models.Timesheet, 'findAll', async () => []);
  const { calls, pdf } = await generate(t, 'salary', require('../controllers/salaryController').generatePayslip);
  assert.equal(pdf.getPageCount(), 1);
  const title = calls.find(call => call.text === 'SALARY SLIP');
  const address = calls.find(call => call.text === company.address);
  assert.ok(address.y + address.height <= title.y);
});
test('unassigned companies never inherit DHPE branding', () => {
  assert.ok(!helper.confidentialityText('').includes('DHPE'));
  assert.ok(helper.confidentialityText(company.name).includes(company.name));
});

test('account company controls retain an explicit selection and avoid silently choosing the first company', () => {
  const source = fs.readFileSync(path.join(__dirname, '../views/superadmin/accounts.ejs'), 'utf8');
  const functions = ['fillAccountCompanySelect', 'syncProjectCompanyFromClient'].map(name => {
    const start = source.indexOf('function ' + name + '(');
    const end = source.indexOf('\nfunction ', start + 1);
    assert.ok(start >= 0 && end > start);
    return source.slice(start, end);
  }).join('\n');
  const select = { value: '', appendChild() {} };
  const clientSelect = { selectedIndex: 1, options: [null, { dataset: { companyId: '1' } }] };
  const context = {
    accountCompanyCache: [otherCompany, company], ACCOUNTS_COMPANY_LOCKED: false,
    document: { getElementById: id => id === 'prj-client-sel' ? clientSelect : select, createElement: () => ({}) },
    accountCompanyOptionLabel: value => value.name,
    findAccountCompanyById: id => [otherCompany, company].find(value => String(value.id) === String(id)),
    findAccountCompanyByName: name => [otherCompany, company].find(value => value.name === name),
  };
  vm.createContext(context);
  vm.runInContext(functions, context);
  vm.runInContext("fillAccountCompanySelect('prj-company-sel', '', {})", context);
  assert.equal(select.value, '');
  vm.runInContext("fillAccountCompanySelect('prj-company-sel', 2, {})", context);
  assert.equal(select.value, '2');
  vm.runInContext('syncProjectCompanyFromClient()', context);
  assert.equal(select.value, '2');
  select.value = '';
  vm.runInContext('syncProjectCompanyFromClient()', context);
  assert.equal(select.value, '1');
});

for (const [name, moduleName, method, model] of [
  ['quotation-huge-item', 'quotationController', 'generatePDF', 'Quotation'],
  ['purchase-order-huge-item', 'purchaseOrderController', 'generatePDF', 'PurchaseOrder'],
  ['work-order-huge-item', 'workOrderController', 'generatePDF', 'WorkOrder'],
  ['proforma-huge-item', 'proformaDbController', 'generatePDF', 'Proforma'],
  ['invoice-huge-item', 'invoiceController', 'downloadPDF', 'Invoice'],
]) {
  test(`${name} splits a single item across pages without losing its final words`, async t => {
    const huge = (longName + '\n').repeat(40) + 'END-OF-LONG-ITEM';
    const data = account();
    data.items = [{ ...data.items[0], name: huge, description: huge }];
    data.milestones = [{ title: huge, amount: 1000, status: 'Pending' }];
    t.mock.method(models[model], 'findByPk', async () => data);
    const { calls, pdf } = await generate(t, name, require('../controllers/' + moduleName)[method]);
    assert.ok(pdf.getPageCount() >= 2);
    assert.ok(calls.some(call => call.text.includes('END-OF-LONG-ITEM')));
  });
}
test('ad-hoc proforma repeats table headers and hides only item tax columns', async t => {
  const { calls, pdf } = await generate(t, 'proforma-no-item-tax', require('../controllers/proformaController').generatePDF, {
    body: account({ showTaxPercentInPdf: false }) });
  assert.ok(pdf.getPageCount() >= 2);
  assert.ok(calls.filter(call => call.text === 'Description').length >= 2);
  assert.ok(!calls.some(call => call.text === 'Tax %' || call.text === 'Tax Amt'));
  assert.ok(calls.some(call => call.text.startsWith('CGST @')));
});

for (const [name, moduleName, method, model] of [
  ['invoice-mixed-tax', 'invoiceController', 'downloadPDF', 'Invoice'],
  ['proforma-mixed-tax', 'proformaDbController', 'generatePDF', 'Proforma'],
  ['quotation-mixed-tax', 'quotationController', 'generatePDF', 'Quotation'],
]) {
  test(`${name} expands wrapped GST labels without overlapping the next row`, async t => {
    const data = account();
    data.items = [0, 0.1, 0.25, 1, 3, 5, 6, 12, 18, 28].map((rate, index) => ({
      ...data.items[index], taxRate: rate, cgst: rate, sgst: rate, taxAmount: rate * 2,
    }));
    t.mock.method(models[model], 'findByPk', async () => data);
    const { calls } = await generate(t, name, require('../controllers/' + moduleName)[method]);
    const cgst = calls.find(call => call.text.startsWith('CGST @'));
    const sgst = calls.find(call => call.text.startsWith('SGST @'));
    assert.ok(cgst && sgst);
    assert.ok(cgst.y + cgst.height <= sgst.y, `${name}: GST summary labels overlap`);
  });
}
test('ad-hoc proforma grows wrapped GST summary rows instead of overlapping them', async t => {
  const data = account();
  data.items = [0, 0.1, 0.25, 1, 3, 5, 6, 12, 18, 28].map((rate, index) => ({
    ...data.items[index], taxRate: rate, cgst: rate, sgst: rate, taxAmount: rate * 2,
  }));
  const { calls } = await generate(t, 'proforma-adhoc-mixed-tax', require('../controllers/proformaController').generatePDF, { body: data });
  const sgst = calls.find(call => call.text.startsWith('SGST @'));
  const cgst = calls.find(call => call.text.startsWith('CGST @'));
  assert.ok(sgst && cgst && sgst.height > 10, 'mixed-rate GST label should wrap');
  assert.ok(sgst.y + sgst.height <= cgst.y, 'ad-hoc GST summary labels overlap');
});
test('amount in words reads naturally, including paise and zero', () => {
  assert.equal(helper.numWords(6608), 'Rupees Six Thousand Six Hundred Eight Only');
  assert.equal(helper.numWords(2146.7), 'Rupees Two Thousand One Hundred Forty Six and Seventy Paise Only');
  assert.equal(helper.numWords(0), 'Rupees Zero Only');
  assert.equal(helper.numWords(9.999), 'Rupees Ten Only');
});
for (const [name, moduleName, method, model] of [
  ['invoice-wide-values', 'invoiceController', 'downloadPDF', 'Invoice'],
  ['proforma-wide-values', 'proformaDbController', 'generatePDF', 'Proforma'],
  ['quotation-wide-values', 'quotationController', 'generatePDF', 'Quotation'],
  ['purchase-order-wide-values', 'purchaseOrderController', 'generatePDF', 'PurchaseOrder'],
  ['proforma-adhoc-wide-values', 'proformaController', 'generatePDF', null],
]) {
  test(`${name} keeps row numbers above 99, large values and long codes inside their rows`, async t => {
    const data = account();
    data.items = Array.from({ length: 105 }, (_, index) => ({
      ...data.items[0], name: 'Item ' + (index + 1), itemCode: 'STEEL-TMT-FE500D-12MM-' + (index + 1),
      unit: 'Running Metre', quantity: 12345.678, qty: 12345.678, unitPrice: 1234567.89, rate: 1234567.89,
      taxableAmount: 15241578750.01, cgst: 1371742087.5, sgst: 1371742087.5, taxAmount: 2743484175, itemTotal: 17985062925.01,
    }));
    if (model) t.mock.method(models[model], 'findByPk', async () => data);
    const { calls } = await generate(t, name, require('../controllers/' + moduleName)[method], model ? {} : { body: data });
    const serial = calls.find(call => call.text === '100');
    assert.ok(serial && serial.height < 12, `${name}: row number 100 wraps`);
    for (let n = 1; n < 105; n += 1) {
      const code = calls.find(call => call.text === 'STEEL-TMT-FE500D-12MM-' + n);
      const next = calls.find(call => call.text === String(n + 1) && call.width < 30);
      if (!code || !next || code.page !== next.page) continue;
      assert.ok(code.y + code.height <= next.y + 0.5, `${name}: item ${n} code spills into the next row`);
    }
  });
}
for (const [name, moduleName, method, model] of [
  ['invoice-long-work-details', 'invoiceController', 'downloadPDF', 'Invoice'],
  ['invoice-landscape-long-work-details', 'invoiceController', 'downloadPDF', 'Invoice'],
  ['proforma-long-work-details', 'proformaDbController', 'generatePDF', 'Proforma'],
  ['proforma-adhoc-long-work-details', 'proformaController', 'generatePDF', null],
]) {
  test(`${name} continues long work details on the next page instead of under the footer`, async t => {
    const data = account({ workDetails: description.repeat(12) + '\nEND-OF-WORK-DETAILS' });
    if (model) t.mock.method(models[model], 'findByPk', async () => data);
    const { calls, pdf } = await generate(t, name, require('../controllers/' + moduleName)[method],
      model ? { query: { orientation: name.includes('landscape') ? 'landscape' : 'portrait' } } : { body: data });
    assert.ok(pdf.getPageCount() >= 2);
    assert.ok(calls.some(call => call.text.includes('END-OF-WORK-DETAILS')));
  });
}
test('quotation without seller contact details never prints another company address', async t => {
  t.mock.method(models.Quotation, 'findByPk', async () => account({ sellerAddress: '', sellerPhone: '', sellerEmail: '' }));
  const { calls } = await generate(t, 'quotation-no-seller-contact', require('../controllers/quotationController').generatePDF);
  assert.ok(!calls.some(call => /Purbachal|dhpe\.in|9876543210/.test(call.text)));
});
test('work order milestone columns span the table so Status is centred in its cell', async t => {
  t.mock.method(models.WorkOrder, 'findByPk', async () => account());
  const { calls } = await generate(t, 'work-order-columns', require('../controllers/workOrderController').generatePDF);
  const status = calls.find(call => call.text === 'Status');
  assert.equal(Math.round(status.x + status.width + 2), helper.X + helper.W);
});
test('salary slip keeps long company and employee details from overlapping', async t => {
  const longCompany = { ...company,
    name: 'DHARMAPURI HIGHWAY & PUBLIC ENGINEERING CONSTRUCTION AND CIVIL INFRASTRUCTURE SERVICES PRIVATE LIMITED',
    email: 'accounts.receivable.department@dharmapuri-highway-engineering.example.co.in',
    phone: '+91 98300 00000 / +91 33 4000 0000' };
  t.mock.method(models.Salary, 'findByPk', async () => record({ id: 1, companyId: 2, company: longCompany, month: 10,
    year: 2026, userId: 5, basicSalary: 912345.67, hra: 1500, conveyance: 2700, specialAllowance: 3700,
    bonus: 2500, totalDays: 31, workedDays: 31, allowedLeave: 2, status: 'finalized',
    user: { id: 5, companyId: 2, role: 'employee', name: 'Venkata Subramanian Lakshminarayanan Raghavendra Krishnamurthy',
      email: 'venkata.subramanian.lakshminarayanan@dharmapuri-highway-engineering.example.co.in',
      department: 'Highway Construction & Civil Infrastructure Project Management',
      workLocation: 'Barasat Divisional Site Office, North 24 Parganas' } }));
  const entries = Array.from({ length: 6 }, (_, i) => ({ date: '2026-10-0' + (i + 1), hours: 8,
    projectId: i + 1, project: longName, workItem: 'Zone ' + i, billingType: 'Billable' }));
  t.mock.method(models.Timesheet, 'findAll', async () => [{ entries }]);
  const { calls, pdf } = await generate(t, 'salary-long-fields', require('../controllers/salaryController').generatePayslip);
  assert.equal(pdf.getPageCount(), 1);
  const at = text => calls.find(call => call.text === text);
  const bottom = call => call.y + call.height;
  const header = [at(longCompany.name), at(company.address), at(longCompany.phone + ' | ' + longCompany.email), at('SALARY SLIP')];
  header.slice(1).forEach((call, i) => assert.ok(bottom(header[i]) <= call.y + 0.5, 'salary header lines overlap'));
  const rows = ['Employee Name:', 'Department:', 'Work Location:', 'Email:', 'Pay Period:'].map(at);
  rows.slice(1).forEach((row, i) => {
    calls.filter(call => call.y >= rows[i].y && call.y < row.y)
      .forEach(call => assert.ok(bottom(call) <= row.y + 0.5, 'employee details overlap the next row: ' + call.text.slice(0, 40)));
  });
  const work = calls.filter(call => call.text.startsWith('Repairing of footpaths'));
  assert.ok(work.length && work.every(call => call.height < 10), 'work summary labels stay on one line');
});
for (const orientation of ['portrait', 'landscape']) {
  test(`R.A. bill ${orientation} preserves quantities and amount in the PDF`, async t => {
    const data = account({ isRABill: true, raBillNo: 2 });
    data.items = [{ ...data.items[0], originalQty: 10, previousQty: 3, quantity: 2, cumulativeQty: 5, balanceQty: 5 }];
    t.mock.method(models.Invoice, 'findByPk', async () => data);
    const { calls } = await generate(t, 'ra-bill-' + orientation, require('../controllers/invoiceController').downloadPDF, { query: { orientation } });
    assert.ok(calls.some(call => call.text === 'Orig. Qty'));
    assert.ok(calls.some(call => call.text === 'Prev. Qty'));
    assert.ok(calls.some(call => call.text === 'Bal. Qty'));
    assert.ok(calls.some(call => call.text.includes('6,608.00')));
    assert.equal(data.items[0].previousQty, 3);
    assert.equal(data.items[0].cumulativeQty, 5);
  });
}
