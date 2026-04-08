const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const SpreadsheetWorkbook = sequelize.define('SpreadsheetWorkbook', {
  userId:      { type: DataTypes.INTEGER, allowNull: false },
  companyId:   { type: DataTypes.INTEGER, allowNull: true },
  name:        { type: DataTypes.STRING(200), defaultValue: 'Workbook 1' },
  sheetsData:  {
    type: DataTypes.TEXT('long'),
    defaultValue: '[]',
    get() {
      const v = this.getDataValue('sheetsData');
      try { return JSON.parse(v || '[]'); } catch { return []; }
    },
    set(v) {
      this.setDataValue('sheetsData', typeof v === 'string' ? v : JSON.stringify(v));
    },
  },
  activeSheet: { type: DataTypes.STRING(200), defaultValue: 'Sheet1' },
}, { timestamps: true });

module.exports = SpreadsheetWorkbook;
