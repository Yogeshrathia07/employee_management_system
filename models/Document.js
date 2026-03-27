const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// Use STRING instead of ENUM for high-cardinality fields to avoid MySQL's
// 64-index-per-table hard limit (each ENUM + paranoid + FK associations adds indexes).
const Document = sequelize.define('Document', {
  userId:    { type: DataTypes.INTEGER, allowNull: false },
  companyId: { type: DataTypes.INTEGER, allowNull: true },
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
  verificationNote:   { type: DataTypes.TEXT, defaultValue: '' },

  // For degree label
  degreeLabel: { type: DataTypes.STRING, defaultValue: '' },

  fileName:   { type: DataTypes.STRING, allowNull: false },
  filePath:   { type: DataTypes.STRING, allowNull: false },
  fileSize:   { type: DataTypes.INTEGER, defaultValue: 0 },
  mimeType:   { type: DataTypes.STRING, defaultValue: '' },
  uploadedBy: { type: DataTypes.INTEGER, allowNull: true },
  notes:      { type: DataTypes.TEXT, defaultValue: '' },
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

// Max uploads per type
Document.getMaxForType = function (type) {
  const uniqueTypes = ['aadhaar', 'pan_card', 'passport', 'voter_id', 'bank_passbook', 'photo', 'resume', 'character_certificate'];
  if (uniqueTypes.includes(type)) return 1;
  if (type === 'degree_certificate') return 4;
  if (type === 'technical_certification') return 20;
  return 5;
};

module.exports = Document;
