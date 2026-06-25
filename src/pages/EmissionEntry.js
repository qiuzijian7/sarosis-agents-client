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
  Alert,
  Snackbar,
  Card,
  CardContent,
  InputAdornment,
  Tooltip,
} from '@mui/material';
import {
  Add as AddIcon,
  Delete as DeleteIcon,
  Save as SaveIcon,
  Calculate as CalculateIcon,
  Upload as UploadIcon,
  Download as DownloadIcon,
} from '@mui/icons-material';
import { useEmission } from '../context/EmissionContext';
import { format } from 'date-fns';

const ACTIVITY_TYPES = {
  scope1: [
    { value: 'natural_gas', label: '天然气', unit: 'm³' },
    { value: 'gasoline', label: '汽油', unit: 'L' },
    { value: 'diesel', label: '柴油', unit: 'L' },
    { value: 'coal', label: '煤炭', unit: 'kg' },
  ],
  scope2: [
    { value: 'electricity', label: '外购电力', unit: 'kWh' },
    { value: 'heat', label: '外购热力', unit: 'GJ' },
  ],
  scope3: [
    { value: 'business_travel', label: '商务差旅', unit: 'km' },
    { value: 'waste', label: '废弃物处理', unit: 'kg' },
    { value: 'water', label: '水资源使用', unit: 'm³' },
    { value: 'employee_commute', label: '员工通勤', unit: 'km' },
  ],
};

const DEPARTMENTS = ['生产部', '行政部', '研发部', '市场部', '财务部', '人力资源部'];

function EmissionEntry() {
  const { emissionData, addEmissionRecord, updateEmissionRecord, deleteEmissionRecord, emissionFactors } = useEmission();
  
  const [formData, setFormData] = useState({
    date: format(new Date(), 'yyyy-MM-dd'),
    category: 'scope2',
    activityType: 'electricity',
    activityAmount: '',
    department: '生产部',
    notes: '',
  });
  
  const [batchData, setBatchData] = useState([]);
  const [showBatchInput, setShowBatchInput] = useState(false);
  const [snackbar, setSnackbar] = useState({ open: false, message: '', severity: 'success' });

  const handleInputChange = (field, value) => {
    setFormData(prev => ({
      ...prev,
      [field]: value,
      // Reset activity type when category changes
      ...(field === 'category' ? { activityType: ACTIVITY_TYPES[value][0].value } : {}),
    }));
  };

  const calculateEmission = () => {
    const factor = emissionFactors[formData.activityType]?.factor || 0;
    const amount = parseFloat(formData.activityAmount) || 0;
    return (amount * factor).toFixed(2);
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    
    if (!formData.activityAmount || parseFloat(formData.activityAmount) <= 0) {
      setSnackbar({
        open: true,
        message: '请输入有效的活动量',
        severity: 'error',
      });
      return;
    }

    const record = {
      ...formData,
      activityAmount: parseFloat(formData.activityAmount),
      emissionFactor: emissionFactors[formData.activityType].factor,
      unit: emissionFactors[formData.activityType].unit,
    };

    addEmissionRecord(record);
    
    setSnackbar({
      open: true,
      message: '排放数据录入成功',
      severity: 'success',
    });

    // Reset form
    setFormData({
      date: format(new Date(), 'yyyy-MM-dd'),
      category: 'scope2',
      activityType: 'electricity',
      activityAmount: '',
      department: '生产部',
      notes: '',
    });
  };

  const handleBatchUpload = (event) => {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const text = e.target.result;
        const lines = text.split('\n').filter(line => line.trim());
        const headers = lines[0].split(',').map(h => h.trim());
        
        const data = lines.slice(1).map((line, index) => {
          const values = line.split(',').map(v => v.trim());
          return headers.reduce((obj, header, i) => {
            obj[header] = values[i] || '';
            return obj;
          }, { id: `batch-${Date.now()}-${index}` });
        });

        setBatchData(data);
        setShowBatchInput(true);
        
        setSnackbar({
          open: true,
          message: `成功解析 ${data.length} 条记录`,
          severity: 'success',
        });
      } catch (error) {
        setSnackbar({
          open: true,
          message: '文件解析失败，请检查格式',
          severity: 'error',
        });
      }
    };
    reader.readAsText(file);
  };

  const handleBatchSubmit = () => {
    batchData.forEach(record => {
      addEmissionRecord({
        date: record.date || format(new Date(), 'yyyy-MM-dd'),
        category: record.category || 'scope2',
        activityType: record.activityType || 'electricity',
        activityAmount: parseFloat(record.activityAmount) || 0,
        department: record.department || '未分类',
        notes: record.notes || '批量导入',
      });
    });

    setBatchData([]);
    setShowBatchInput(false);
    
    setSnackbar({
      open: true,
      message: `成功导入 ${batchData.length} 条记录`,
      severity: 'success',
    });
  };

  const handleDelete = (id) => {
    deleteEmissionRecord(id);
    setSnackbar({
      open: true,
      message: '记录已删除',
      severity: 'info',
    });
  };

  const exportTemplate = () => {
    const template = 'date,category,activityType,activityAmount,department,notes\n' +
      '2024-01-01,scope2,electricity,1000,生产部,示例数据';
    
    const blob = new Blob([template], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = '碳排放数据导入模板.csv';
    link.click();
  };

  return (
    <Container maxWidth="xl" sx={{ mt: 4, mb: 4 }}>
      <Typography variant="h4" component="h1" gutterBottom>
        碳排放数据录入
      </Typography>

      <Grid container spacing={3}>
        {/* Single Entry Form */}
        <Grid item xs={12} md={6}>
          <Paper sx={{ p: 3 }}>
            <Typography variant="h6" gutterBottom>
              手动录入
            </Typography>
            <Box component="form" onSubmit={handleSubmit}>
              <Grid container spacing={2}>
                <Grid item xs={12} sm={6}>
                  <TextField
                    fullWidth
                    label="日期"
                    type="date"
                    value={formData.date}
                    onChange={(e) => handleInputChange('date', e.target.value)}
                    InputLabelProps={{ shrink: true }}
                    required
                  />
                </Grid>
                <Grid item xs={12} sm={6}>
                  <FormControl fullWidth required>
                    <InputLabel>排放范围</InputLabel>
                    <Select
                      value={formData.category}
                      onChange={(e) => handleInputChange('category', e.target.value)}
                      label="排放范围"
                    >
                      <MenuItem value="scope1">范围一 (直接排放)</MenuItem>
                      <MenuItem value="scope2">范围二 (能源间接排放)</MenuItem>
                      <MenuItem value="scope3">范围三 (其他间接排放)</MenuItem>
                    </Select>
                  </FormControl>
                </Grid>
                <Grid item xs={12} sm={6}>
                  <FormControl fullWidth required>
                    <InputLabel>排放源类型</InputLabel>
                    <Select
                      value={formData.activityType}
                      onChange={(e) => handleInputChange('activityType', e.target.value)}
                      label="排放源类型"
                    >
                      {ACTIVITY_TYPES[formData.category].map(type => (
                        <MenuItem key={type.value} value={type.value}>
                          {type.label}
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                </Grid>
                <Grid item xs={12} sm={6}>
                  <TextField
                    fullWidth
                    label="活动量"
                    type="number"
                    value={formData.activityAmount}
                    onChange={(e) => handleInputChange('activityAmount', e.target.value)}
                    InputProps={{
                      endAdornment: (
                        <InputAdornment position="end">
                          {emissionFactors[formData.activityType]?.unit}
                        </InputAdornment>
                      ),
                    }}
                    required
                  />
                </Grid>
                <Grid item xs={12} sm={6}>
                  <FormControl fullWidth required>
                    <InputLabel>部门</InputLabel>
                    <Select
                      value={formData.department}
                      onChange={(e) => handleInputChange('department', e.target.value)}
                      label="部门"
                    >
                      {DEPARTMENTS.map(dept => (
                        <MenuItem key={dept} value={dept}>{dept}</MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                </Grid>
                <Grid item xs={12} sm={6}>
                  <Card variant="outlined">
                    <CardContent>
                      <Typography variant="body2" color="textSecondary">
                        预估排放量
                      </Typography>
                      <Typography variant="h5" color="primary">
                        {calculateEmission()} kg CO₂eq
                      </Typography>
                      <Typography variant="caption" color="textSecondary">
                        排放因子: {emissionFactors[formData.activityType]?.factor} kg CO₂/{emissionFactors[formData.activityType]?.unit}
                      </Typography>
                    </CardContent>
                  </Card>
                </Grid>
                <Grid item xs={12}>
                  <TextField
                    fullWidth
                    label="备注"
                    multiline
                    rows={2}
                    value={formData.notes}
                    onChange={(e) => handleInputChange('notes', e.target.value)}
                  />
                </Grid>
                <Grid item xs={12}>
                  <Button
                    type="submit"
                    variant="contained"
                    startIcon={<SaveIcon />}
                    fullWidth
                    size="large"
                  >
                    保存记录
                  </Button>
                </Grid>
              </Grid>
            </Box>
          </Paper>
        </Grid>

        {/* Batch Upload */}
        <Grid item xs={12} md={6}>
          <Paper sx={{ p: 3 }}>
            <Typography variant="h6" gutterBottom>
              批量导入
            </Typography>
            <Box mb={2}>
              <Button
                variant="outlined"
                component="label"
                startIcon={<UploadIcon />}
                fullWidth
                sx={{ mb: 1 }}
              >
                上传 CSV 文件
                <input
                  type="file"
                  hidden
                  accept=".csv,.xlsx,.xls"
                  onChange={handleBatchUpload}
                />
              </Button>
              <Button
                variant="text"
                startIcon={<DownloadIcon />}
                onClick={exportTemplate}
                fullWidth
              >
                下载导入模板
              </Button>
            </Box>

            {showBatchInput && batchData.length > 0 && (
              <Box>
                <Alert severity="info" sx={{ mb: 2 }}>
                  已解析 {batchData.length} 条记录，请确认后提交
                </Alert>
                <TableContainer sx={{ maxHeight: 300 }}>
                  <Table size="small" stickyHeader>
                    <TableHead>
                      <TableRow>
                        <TableCell>日期</TableCell>
                        <TableCell>排放源</TableCell>
                        <TableCell>活动量</TableCell>
                        <TableCell>部门</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {batchData.slice(0, 5).map((row, index) => (
                        <TableRow key={index}>
                          <TableCell>{row.date}</TableCell>
                          <TableCell>{row.activityType}</TableCell>
                          <TableCell>{row.activityAmount}</TableCell>
                          <TableCell>{row.department}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
                {batchData.length > 5 && (
                  <Typography variant="caption" color="textSecondary">
                    ... 还有 {batchData.length - 5} 条记录
                  </Typography>
                )}
                <Button
                  variant="contained"
                  color="primary"
                  onClick={handleBatchSubmit}
                  fullWidth
                  sx={{ mt: 2 }}
                >
                  确认导入 {batchData.length} 条记录
                </Button>
              </Box>
            )}
          </Paper>
        </Grid>

        {/* Recent Records */}
        <Grid item xs={12}>
          <Paper sx={{ p: 3 }}>
            <Typography variant="h6" gutterBottom>
              最近录入记录
            </Typography>
            <TableContainer>
              <Table>
                <TableHead>
                  <TableRow>
                    <TableCell>日期</TableCell>
                    <TableCell>排放源</TableCell>
                    <TableCell>活动量</TableCell>
                    <TableCell>排放因子</TableCell>
                    <TableCell>排放量 (kg)</TableCell>
                    <TableCell>部门</TableCell>
                    <TableCell>操作</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {emissionData.slice(-10).reverse().map((record) => (
                    <TableRow key={record.id}>
                      <TableCell>{record.date}</TableCell>
                      <TableCell>{record.activityType}</TableCell>
                      <TableCell>{record.activityAmount} {record.unit}</TableCell>
                      <TableCell>{record.emissionFactor}</TableCell>
                      <TableCell>{record.emissionAmount.toFixed(2)}</TableCell>
                      <TableCell>{record.department}</TableCell>
                      <TableCell>
                        <Tooltip title="删除">
                          <IconButton
                            size="small"
                            color="error"
                            onClick={() => handleDelete(record.id)}
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
          </Paper>
        </Grid>
      </Grid>

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

export default EmissionEntry;
