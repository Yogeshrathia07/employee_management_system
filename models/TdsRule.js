const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// TDS master: rate + threshold rules used when a payment breakup is calculated.
// thresholdBasis:
//   whole   — once the single-payment or FY-aggregate limit is crossed, TDS is
//             due on the payment; when the FY aggregate crosses the limit, the
//             earlier untaxed payments of the year are taxed too (194C/194J/194H…)
//   excess  — TDS only on the part of the FY aggregate above the limit (194Q)
//   current — TDS only on the current payment once a limit is crossed
const TdsRule = sequelize.define('TdsRule', {
  code:           { type: DataTypes.STRING(30),  allowNull: false },
  nature:         { type: DataTypes.STRING(120), allowNull: false },
  section:        { type: DataTypes.STRING(20),  defaultValue: '' },
  payeeType:      { type: DataTypes.STRING(120), defaultValue: '' },
  rate:           { type: DataTypes.DECIMAL(6, 3),  defaultValue: 0 },
  singleLimit:    { type: DataTypes.DECIMAL(14, 2), defaultValue: 0 },  // 0 = no single-payment limit
  aggregateLimit: { type: DataTypes.DECIMAL(14, 2), defaultValue: 0 },  // 0 = no FY aggregate limit
  thresholdBasis: { type: DataTypes.STRING(20),  defaultValue: 'whole' },
  conditionNote:  { type: DataTypes.TEXT },
  applicableFrom: { type: DataTypes.DATEONLY, allowNull: true },
  applicableTo:   { type: DataTypes.DATEONLY, allowNull: true },
  active:         { type: DataTypes.BOOLEAN, defaultValue: true },
  companyId:      { type: DataTypes.INTEGER, allowNull: true },
  createdBy:      { type: DataTypes.INTEGER, allowNull: true },
}, { timestamps: true });

module.exports = TdsRule;
