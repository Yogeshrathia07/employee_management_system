const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');
const HRDocs = require('../public/js/hr-documents');

// Use STRING instead of ENUM for high-cardinality fields to avoid MySQL's
// 64-index-per-table hard limit (each ENUM + paranoid + FK associations adds indexes).
const Document = sequelize.define('Document', {
  userId:    { type: DataTypes.INTEGER, allowNull: false },
  companyId: { type: DataTypes.INTEGER, allowNull: true },
  // The client that issued an offer letter, when the document is client-issued.
  // This deliberately has no model index: MySQL installations can otherwise
  // exceed their per-table key limit after repeated schema synchronisation.
  clientId:  { type: DataTypes.INTEGER, allowNull: true },
  title:     { type: DataTypes.STRING, allowNull: false },

  // STRING instead of ENUM — validated at controller layer
  type:     { type: DataTypes.STRING(50), defaultValue: 'other' },
  category: { type: DataTypes.STRING(30), defaultValue: 'other' },

  isMandatory:    { type: DataTypes.BOOLEAN, defaultValue: false },
  genuineConsent: { type: DataTypes.BOOLEAN, defaultValue: false },

  // Verification
  verificationStatus: { type: DataTypes.STRING(20), defaultValue: 'pending' },
  verifiedBy:         { type: DataTypes.INTEGER, allowNull: true },
  verifiedAt:         { type: DataTypes.DATE, allowNull: true },
  verificationNote:   { type: DataTypes.TEXT },

  // For degree label
  degreeLabel: { type: DataTypes.STRING, defaultValue: '' },

  fileName:   { type: DataTypes.STRING, allowNull: false },
  filePath:   { type: DataTypes.STRING, allowNull: false },
  fileSize:   { type: DataTypes.INTEGER, defaultValue: 0 },
  mimeType:   { type: DataTypes.STRING, defaultValue: '' },
  uploadedBy: { type: DataTypes.INTEGER, allowNull: true },
  notes:      { type: DataTypes.TEXT },

  // HR documents issued by the company (offer letter, appointment letter…)
  issuedByCompany:     { type: DataTypes.BOOLEAN, defaultValue: false },
  employeeCanView:     { type: DataTypes.BOOLEAN, defaultValue: true },
  employeeCanDownload: { type: DataTypes.BOOLEAN, defaultValue: true },
  issueDate:           { type: DataTypes.DATEONLY, allowNull: true },
  version:             { type: DataTypes.INTEGER, defaultValue: 1 },
  replacedAt:          { type: DataTypes.DATE, allowNull: true },
}, {
  timestamps: true,
  paranoid: true,
  // Disable Sequelize auto-creating indexes for every column —
  // we only need the ones we explicitly define.
  indexes: [
    { fields: ['userId'] },
    { fields: ['companyId'] },
  ],
});

// Mandatory document types
Document.MANDATORY_TYPES = [
  'aadhaar', 'pan_card', 'voter_id', 'passport',
  'bank_passbook', 'medical_document', 'character_certificate',
];

// Documents the company (admin / client side) issues to an employee. They are
// shown read-only on the employee profile, with view / download controlled by
// employeeCanView / employeeCanDownload.
Document.HR_ISSUED_TYPES = HRDocs.HR_ISSUED_TYPES;
Document.PROFILE_SECTIONS = HRDocs.PROFILE_SECTIONS;

// Max uploads per type
Document.getMaxForType = function (type) {
  const uniqueTypes = ['aadhaar', 'pan_card', 'passport', 'voter_id', 'bank_passbook', 'photo', 'resume', 'character_certificate'];
  if (uniqueTypes.includes(type)) return 1;
  if (type === 'degree_certificate') return 4;
  if (type === 'temporary_document') return 20;
  if (type === 'technical_certification') return 20;
  if (type === 'hr_document') return 20;
  return 5;
};

module.exports = Document;
