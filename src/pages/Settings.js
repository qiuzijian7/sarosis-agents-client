import React, { useState } from 'react';
import {
  Container,
  Paper,
  Typography,
  Box,
  Grid,
  TextField,
  Button,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  IconButton,
  Tooltip,
  Card,
  CardContent,
  Alert,
  Snackbar,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Tabs,
  Tab,
  Switch,
  FormControlLabel,
} from '@mui/material';
import {
  Add as AddIcon,
  Edit as EditIcon,
  Delete as DeleteIcon,
  Save as SaveIcon,
  Restore as ResetIcon,
  Upload as ImportIcon,
  Download as ExportIcon,
} from '@mui/icons-material';
import { useAuth } from '../context/AuthContext';
import { useEmission } from '../context/EmissionContext';

const DEFAULT_FACTORS = {
  electricity: { name: '外购电力', factor: 0.5703, unit: 'kWh', source: 'GB/T 32150-2015', category: 'scope2' },
  natural_gas: { name: '天然气', factor: 1.962, unit: 'm³', source: 'GB/T 32150-2015', category: 'scope1' },
  gasoline: { name: '汽油', factor: 2.925, unit: 'L', source: 'GB/T 32150-2015', category: 'scope1' },
  diesel: { name: '柴油', factor: 3.096, unit: 'L', source: 'GB/T 32150-2015', category: 'scope1' },
  coal: { name: '煤炭', factor: 1.900, unit: 'kg', source: 'GB/T 32150-2015', category: 'scope1' },
  business_travel: { name: '商务差旅', factor: 0.277, unit: 'km', source: 'IPCC 2006', category: 'scope3' },
  waste: { name: '废弃物处理', factor: 0.608, unit: 'kg', source: 'IPCC 2006', category: 'scope3' },
  water: { name: '水资源使用', factor: 0.0003, unit: 'm³', source: 'IPCC 2006', category: 'scope3' },
  employee_commute: { name: '员工通勤', factor: 0.277, unit: 'km', source: 'IPCC 2006', category: 'scope3' },
  heat: { name: '外购热力', factor: 0.11, unit: 'GJ', source: 'GB/T 32150-2015', category: 'scope2' },
};

function Settings() {
  const { user, logout } = useAuth();
  const { emissionFactors, emissionData } = useEmission();
  
  const [activeTab, setActiveTab] = useState(0);
  const [factors, setFactors] = useState(() => {
    const stored = localStorage.getItem('carbonTrackFactors');
    return stored ? JSON.parse(stored) : DEFAULT_FACTORS;
  });
  
  const [factorDialog, setFactorDialog] = useState({ open: false, factor: null, key: '' });
  const [userDialog, setUserDialog] = useState({ open: false, user: null });
  const [snackbar, setSnackbar] = useState({ open: false, message: '', severity: 'success' });
  
  const [systemSettings, setSystemSettings] = useState({
    companyName: '我的企业',
    reportingYear: new Date().getFullYear(),
    currency: 'CNY',
    language: 'zh-CN',
    autoSave: true,
    enableNotifications: true,
    dataRetentionDays: 365,
  });

  const handleTabChange = (event, newValue) => {
    setActiveTab(newValue);
  };

  const handleFactorSave = () => {
    if (factorDialog.key && factorDialog.factor) {
      const updated = {
        ...factors,
        [factorDialog.key]: factorDialog.factor,
      };
      setFactors(updated);
      localStorage.setItem('carbonTrackFactors', JSON.stringify(updated));
      setFactorDialog({ open: false, factor: null, key: '' });
      setSnackbar({
        open: true,
        message: '排放因子已更新',
        severity: 'success',
      });
    }
  };

  const handleFactorDelete = (key) => {
    const updated = { ...factors };
    delete updated[key];
    setFactors(updated);
    localStorage.setItem('carbonTrackFactors', JSON.stringify(updated));
    setSnackbar({
      open: true,
      message: '排放因子已删除',
      severity: 'info',
    });
  };

  const handleAddFactor = () => {
    setFactorDialog({
      open: true,
      key: '',
      factor: {
        name: '',
        factor: 0,
        unit: '',
        source: '',
        category: 'scope2',
      },
    });
  };

  const handleEditFactor = (key) => {
    setFactorDialog({
      open: true,
      key,
      factor: { ...factors[key] },
    });
  };

  const handleResetFactors = () => {
    setFactors(DEFAULT_FACTORS);
    localStorage.setItem('carbonTrackFactors', JSON.stringify(DEFAULT_FACTORS));
    setSnackbar({
      open: true,
      message: '排放因子已重置为默认值',
      severity: 'success',
    });
  };

  const handleSystemSettingChange = (field, value) => {
    setSystemSettings(prev => ({ ...prev, [field]: value }));
    localStorage.setItem('carbonTrackSettings', JSON.stringify({
      ...systemSettings,
      [field]: value,
    }));
  };

  const handleExportData = () => {
    const exportData = {
      version: '1.0.0',
      exportDate: new Date().toISOString(),
      emissionData,
      factors,
      settings: systemSettings,
    };
    
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `CarbonTrack_备份_${new Date().toISOString().split('T')[0]}.json`;
    link.click();
    
    setSnackbar({
      open: true,
      message: '数据导出成功',
      severity: 'success',
    });
  };

  const handleImportData = (event) => {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target.result);
        
        if (data.emissionData) {
          localStorage.setItem('carbonTrackEmissions', JSON.stringify(data.emissionData));
        }
        if (data.factors) {
          setFactors(data.factors);
          localStorage.setItem('carbonTrackFactors', JSON.stringify(data.factors));
        }
        if (data.settings) {
          setSystemSettings(data.settings);
          localStorage.setItem('carbonTrackSettings', JSON.stringify(data.settings));
        }
        
        setSnackbar({
          open: true,
          message: '数据导入成功，请刷新页面',
          severity: 'success',
        });
      } catch (error) {
        setSnackbar({
          open: true,
          message: '导入失败：文件格式错误',
          severity: 'error',
        });
      }
    };
    reader.readAsText(file);
  };

  const handleClearData = () => {
    if (window.confirm('确定要清除所有数据吗？此操作不可撤销。')) {
      localStorage.removeItem('carbonTrackEmissions');
      localStorage.removeItem('carbonTrackFactors');
      localStorage.removeItem('carbonTrackSettings');
      setSnackbar({
        open: true,
        message: '所有数据已清除，请刷新页面',
        severity: 'warning',
      });
    }
  };

  return (
    <Container maxWidth="xl" sx={{ mt: 4, mb: 4 }}>
      <Typography variant="h4" component="h1" gutterBottom>
        系统设置
      </Typography>

      <Paper sx={{ mb: 3 }}>
        <Tabs value={activeTab} onChange={handleTabChange}>
          <Tab label="排放因子管理" />
          <Tab label="系统配置" />
          <Tab label="用户管理" />
          <Tab label="数据管理" />
        </Tabs>

        {/* Tab 0: Emission Factors */}
        {activeTab === 0 && (
          <Box p={3}>
            <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
              <Typography variant="h6">
                排放因子库 ({Object.keys(factors).length} 个)
              </Typography>
              <Box>
                <Button
                  variant="outlined"
                  startIcon={<ResetIcon />}
                  onClick={handleResetFactors}
                  sx={{ mr: 1 }}
                >
                  重置为默认
                </Button>
                <Button
                  variant="contained"
                  startIcon={<AddIcon />}
                  onClick={handleAddFactor}
                >
                  添加因子
                </Button>
              </Box>
            </Box>

            <TableContainer>
              <Table>
                <TableHead>
                  <TableRow>
                    <TableCell>编码</TableCell>
                    <TableCell>名称</TableCell>
                    <TableCell>排放范围</TableCell>
                    <TableCell align="right">排放因子</TableCell>
                    <TableCell>单位</TableCell>
                    <TableCell>数据来源</TableCell>
                    <TableCell>操作</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {Object.entries(factors).map(([key, factor]) => (
                    <TableRow key={key}>
                      <TableCell>{key}</TableCell>
                      <TableCell>{factor.name}</TableCell>
                      <TableCell>
                        {factor.category === 'scope1' ? '范围一' :
                         factor.category === 'scope2' ? '范围二' : '范围三'}
                      </TableCell>
                      <TableCell align="right">{factor.factor}</TableCell>
                      <TableCell>{factor.unit}</TableCell>
                      <TableCell>{factor.source}</TableCell>
                      <TableCell>
                        <Tooltip title="编辑">
                          <IconButton
                            size="small"
                            onClick={() => handleEditFactor(key)}
                          >
                            <EditIcon />
                          </IconButton>
                        </Tooltip>
                        <Tooltip title="删除">
                          <IconButton
                            size="small"
                            color="error"
                            onClick={() => handleFactorDelete(key)}
                          >
                            <DeleteIcon />
                          </IconButton>
                        </Tooltip>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </Box>
        )}

        {/* Tab 1: System Settings */}
        {activeTab === 1 && (
          <Box p={3}>
            <Typography variant="h6" gutterBottom>
              系统配置
            </Typography>
            <Grid container spacing={3}>
              <Grid item xs={12} md={6}>
                <TextField
                  fullWidth
                  label="企业名称"
                  value={systemSettings.companyName}
                  onChange={(e) => handleSystemSettingChange('companyName', e.target.value)}
                  margin="normal"
                />
              </Grid>
              <Grid item xs={12} md={6}>
                <FormControl fullWidth margin="normal">
                  <InputLabel>报告年份</InputLabel>
                  <Select
                    value={systemSettings.reportingYear}
                    onChange={(e) => handleSystemSettingChange('reportingYear', e.target.value)}
                    label="报告年份"
                  >
                    {Array.from({ length: 5 }, (_, i) => new Date().getFullYear() - i).map(year => (
                      <MenuItem key={year} value={year}>{year}年</MenuItem>
                    ))}
                  </Select>
                </FormControl>
              </Grid>
              <Grid item xs={12} md={6}>
                <FormControl fullWidth margin="normal">
                  <InputLabel>语言</InputLabel>
                  <Select
                    value={systemSettings.language}
                    onChange={(e) => handleSystemSettingChange('language', e.target.value)}
                    label="语言"
                  >
                    <MenuItem value="zh-CN">简体中文</MenuItem>
                    <MenuItem value="en-US">English</MenuItem>
                  </Select>
                </FormControl>
              </Grid>
              <Grid item xs={12} md={6}>
                <TextField
                  fullWidth
                  label="数据保留天数"
                  type="number"
                  value={systemSettings.dataRetentionDays}
                  onChange={(e) => handleSystemSettingChange('dataRetentionDays', parseInt(e.target.value))}
                  margin="normal"
                />
              </Grid>
              <Grid item xs={12}>
                <FormControlLabel
                  control={
                    <Switch
                      checked={systemSettings.autoSave}
                      onChange={(e) => handleSystemSettingChange('autoSave', e.target.checked)}
                    />
                  }
                  label="自动保存"
                />
                <FormControlLabel
                  control={
                    <Switch
                      checked={systemSettings.enableNotifications}
                      onChange={(e) => handleSystemSettingChange('enableNotifications', e.target.checked)}
                    />
                  }
                  label="启用通知"
                />
              </Grid>
            </Grid>
          </Box>
        )}

        {/* Tab 2: User Management */}
        {activeTab === 2 && (
          <Box p={3}>
            <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
              <Typography variant="h6">
                用户管理
              </Typography>
              <Button
                variant="contained"
                startIcon={<AddIcon />}
                onClick={() => setUserDialog({ open: true, user: null })}
              >
                添加用户
              </Button>
            </Box>

            <TableContainer>
              <Table>
                <TableHead>
                  <TableRow>
                    <TableCell>用户名</TableCell>
                    <TableCell>姓名</TableCell>
                    <TableCell>角色</TableCell>
                    <TableCell>权限</TableCell>
                    <TableCell>最后登录</TableCell>
                    <TableCell>操作</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  <TableRow>
                    <TableCell>{user?.username}</TableCell>
                    <TableCell>{user?.name}</TableCell>
                    <TableCell>
                      {user?.role === 'admin' ? '管理员' : '普通用户'}
                    </TableCell>
                    <TableCell>
                      {user?.permissions?.includes('all') ? '全部权限' : '查看、编辑'}
                    </TableCell>
                    <TableCell>{new Date().toLocaleDateString()}</TableCell>
                    <TableCell>
                      <Tooltip title="编辑">
                        <IconButton size="small">
                          <EditIcon />
                        </IconButton>
                      </Tooltip>
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </TableContainer>

            <Alert severity="info" sx={{ mt: 2 }}>
              演示版本仅显示当前用户。完整版本支持多用户管理、角色权限配置等功能。
            </Alert>
          </Box>
        )}

        {/* Tab 3: Data Management */}
        {activeTab === 3 && (
          <Box p={3}>
            <Typography variant="h6" gutterBottom>
              数据备份与恢复
            </Typography>
            
            <Grid container spacing={3}>
              <Grid item xs={12} md={6}>
                <Card variant="outlined">
                  <CardContent>
                    <Typography variant="h6" gutterBottom>
                      导出数据
                    </Typography>
                    <Typography variant="body2" color="textSecondary" paragraph>
                      将当前所有数据（排放记录、排放因子、系统设置）导出为 JSON 文件备份
                    </Typography>
                    <Button
                      variant="contained"
                      startIcon={<ExportIcon />}
                      onClick={handleExportData}
                      fullWidth
                    >
                      导出备份
                    </Button>
                  </CardContent>
                </Card>
              </Grid>
              
              <Grid item xs={12} md={6}>
                <Card variant="outlined">
                  <CardContent>
                    <Typography variant="h6" gutterBottom>
                      导入数据
                    </Typography>
                    <Typography variant="body2" color="textSecondary" paragraph>
                      从备份文件恢复数据（将覆盖当前数据）
                    </Typography>
                    <Button
                      variant="outlined"
                      component="label"
                      startIcon={<ImportIcon />}
                      fullWidth
                    >
                      导入备份
                      <input
                        type="file"
                        hidden
                        accept=".json"
                        onChange={handleImportData}
                      />
                    </Button>
                  </CardContent>
                </Card>
              </Grid>
              
              <Grid item xs={12}>
                <Card variant="outlined" sx={{ bgcolor: 'error.light', color: 'error.contrastText' }}>
                  <CardContent>
                    <Typography variant="h6" gutterBottom>
                      危险操作
                    </Typography>
                    <Typography variant="body2" paragraph>
                      清除所有本地数据，此操作不可撤销
                    </Typography>
                    <Button
                      variant="contained"
                      color="error"
                      onClick={handleClearData}
                    >
                      清除所有数据
                    </Button>
                  </CardContent>
                </Card>
              </Grid>
            </Grid>
          </Box>
        )}
      </Paper>

      {/* Factor Dialog */}
      <Dialog
        open={factorDialog.open}
        onClose={() => setFactorDialog({ open: false, factor: null, key: '' })}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>
          {factorDialog.key ? '编辑排放因子' : '添加排放因子'}
        </DialogTitle>
        <DialogContent>
          <Grid container spacing={2} sx={{ mt: 1 }}>
            {!factorDialog.key && (
              <Grid item xs={12}>
                <TextField
                  fullWidth
                  label="编码"
                  value={factorDialog.key}
                  onChange={(e) => setFactorDialog({ ...factorDialog, key: e.target.value })}
                  helperText="唯一标识符，如：electricity"
                />
              </Grid>
            )}
            <Grid item xs={12}>
              <TextField
                fullWidth
                label="名称"
                value={factorDialog.factor?.name || ''}
                onChange={(e) => setFactorDialog({
                  ...factorDialog,
                  factor: { ...factorDialog.factor, name: e.target.value }
                })}
              />
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField
                fullWidth
                label="排放因子"
                type="number"
                value={factorDialog.factor?.factor || 0}
                onChange={(e) => setFactorDialog({
                  ...factorDialog,
                  factor: { ...factorDialog.factor, factor: parseFloat(e.target.value) }
                })}
                InputProps={{
                  inputProps: { step: 0.0001 }
                }}
              />
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField
                fullWidth
                label="单位"
                value={factorDialog.factor?.unit || ''}
                onChange={(e) => setFactorDialog({
                  ...factorDialog,
                  factor: { ...factorDialog.factor, unit: e.target.value }
                })}
                helperText="如：kWh, m³, kg"
              />
            </Grid>
            <Grid item xs={12} sm={6}>
              <FormControl fullWidth>
                <InputLabel>排放范围</InputLabel>
                <Select
                  value={factorDialog.factor?.category || 'scope2'}
                  onChange={(e) => setFactorDialog({
                    ...factorDialog,
                    factor: { ...factorDialog.factor, category: e.target.value }
                  })}
                  label="排放范围"
                >
                  <MenuItem value="scope1">范围一 (直接排放)</MenuItem>
                  <MenuItem value="scope2">范围二 (能源间接排放)</MenuItem>
                  <MenuItem value="scope3">范围三 (其他间接排放)</MenuItem>
                </Select>
              </FormControl>
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField
                fullWidth
                label="数据来源"
                value={factorDialog.factor?.source || ''}
                onChange={(e) => setFactorDialog({
                  ...factorDialog,
                  factor: { ...factorDialog.factor, source: e.target.value }
                })}
                helperText="如：GB/T 32150-2015, IPCC 2006"
              />
            </Grid>
          </Grid>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setFactorDialog({ open: false, factor: null, key: '' })}>
            取消
          </Button>
          <Button onClick={handleFactorSave} variant="contained">
            保存
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={snackbar.open}
        autoHideDuration={6000}
        onClose={() => setSnackbar({ ...snackbar, open: false })}
      >
        <Alert severity={snackbar.severity} sx={{ width: '100%' }}>
          {snackbar.message}
        </Alert>
      </Snackbar>
    </Container>
  );
}

export default Settings;
