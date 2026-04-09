const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const ProjectAccount = sequelize.define('ProjectAccount', {
  projectCode: { type: DataTypes.STRING(20),  allowNull: true, unique: true },
  name:        { type: DataTypes.STRING(200), allowNull: false },

  clientId:   { type: DataTypes.INTEGER,     allowNull: true },
  clientName: { type: DataTypes.STRING(200), defaultValue: '' },

  budget:    { type: DataTypes.DECIMAL(14,2), defaultValue: 0 },
  startDate: { type: DataTypes.DATEONLY,      allowNull: true },
  endDate:   { type: DataTypes.DATEONLY,      allowNull: true },

  description: { type: DataTypes.TEXT, defaultValue: '' },

  status: {
    type: DataTypes.ENUM('Planning','Active','Completed','On Hold'),
    defaultValue: 'Planning',
  },
  createdBy: { type: DataTypes.INTEGER, allowNull: true },
}, { timestamps: true });

module.exports = ProjectAccount;
