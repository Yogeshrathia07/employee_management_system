const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// General work / activity master data (e.g. Drafting, Site Visit, Meeting) —
// selectable in timesheets when the work is not tied to one project.
const WorkItem = sequelize.define('WorkItem', {
  code:        { type: DataTypes.STRING(30),  defaultValue: '' },
  name:        { type: DataTypes.STRING(150), allowNull: false },
  category:    { type: DataTypes.STRING(60),  defaultValue: '' },
  description: { type: DataTypes.TEXT },
  billable:    { type: DataTypes.BOOLEAN,     defaultValue: true },
  status:      { type: DataTypes.STRING(20),  defaultValue: 'active' }, // active | inactive
  companyId:   { type: DataTypes.INTEGER,     allowNull: true },
  createdBy:   { type: DataTypes.INTEGER,     allowNull: true },
}, { timestamps: true });

module.exports = WorkItem;
