import React, { useState, useMemo } from 'react';
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
  Tabs,
  Tab,
  Card,
  CardContent,
  Alert,
  Snackbar,
  CircularProgress,
  Divider,
} from '@mui/material';
import {
  Download as DownloadIcon,
  PictureAsPdf as PdfIcon,
  TableChart as ExcelIcon,
  Description as ReportIcon,
  BarChart as ChartIcon,
  Print as PrintIcon,
} from '@mui/icons-material';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  LineChart,
  Line,
  Area,
  AreaChart,
} from 'recharts';
import { useEmission } from '../context/EmissionContext';
import { format, startOfYear, endOfYear, eachMonthOfInterval } from 'date-fns';
import jsPDF from 'jspdf';
import 'jspdf-autotable';
import * as XLSX from 'xlsx';

const COLORS = ['#1976d2', '#dc004e', '#ff9800', '#4caf50', '#9c27b0'];

function Reports() {
  const { emissionData, getYearlyEmissions, getTotalEmissions } = useEmission();
  
  const [activeTab, setActiveTab] = useState(0);
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());
  const [reportType, setReportType] = useState('annual');
  const [isGenerating, setIsGenerating] = useState(false);
  const [snackbar, setSnackbar] = useState({ open: false, message: '', severity: 'success' });

  const years = useMemo(() => {
    const currentYear = new Date().getFullYear();
    return Array.from({ length: 5 }, (_, i) => currentYear - i);
  }, []);

  const yearlyData = useMemo(() => {
    return getYearlyEmissions(selectedYear);
  }, [selectedYear, emissionData]);

  const monthlyData = useMemo(() => {
    const months = eachMonthOfInterval({
      start: startOfYear(new Date(selectedYear, 0, 1)),
      end: endOfYear(new Date(selectedYear, 0, 1)),
    });

    return months.map((month, index) => {
      const monthData = yearlyData.filter(record => 
        new Date(record.date).getMonth() === index
      );
      const totalEmission = monthData.reduce((sum, r) => sum + r.emissionAmount, 0);
      const scope1 = monthData.filter(r => r.category === 'scope1').reduce((sum, r) => sum + r.emissionAmount, 0);
      const scope2 = monthData.filter(r => r.category === 'scope2').reduce((sum, r) => sum + r.emissionAmount, 0);
      const scope3 = monthData.filter(r => r.category === 'scope3').reduce((sum, r) => sum + r.emissionAmount, 0);
      
      return {
        month: format(month, 'M月'),
        total: parseFloat((totalEmission / 1000).toFixed(2)),
        scope1: parseFloat((scope1 / 1000).toFixed(2)),
        scope2: parseFloat((scope2 / 1000).toFixed(2)),
        scope3: parseFloat((scope3 / 1000).toFixed(2)),
      };
    });
  }, [yearlyData, selectedYear]);

  const scopeBreakdown = useMemo(() => {
    const scope1 = yearlyData.filter(r => r.category === 'scope1').reduce((sum, r) => sum + r.emissionAmount, 0);
    const scope2 = yearlyData.filter(r => r.category === 'scope2').reduce((sum, r) => sum + r.emissionAmount, 0);
    const scope3 = yearlyData.filter(r => r.category === 'scope3').reduce((sum, r) => sum + r.emissionAmount, 0);

    return [
      { name: '范围一 (直接排放)', value: parseFloat((scope1 / 1000).toFixed(2)), percentage: 0 },
      { name: '范围二 (能源间接排放)', value: parseFloat((scope2 / 1000).toFixed(2)), percentage: 0 },
      { name: '范围三 (其他间接排放)', value: parseFloat((scope3 / 1000).toFixed(2)), percentage: 0 },
    ].map(item => ({
      ...item,
      percentage: ((item.value / (item.value + scope1/1000 + scope2/1000 + scope3/1000)) * 100).toFixed(1),
    }));
  }, [yearlyData]);

  const departmentAnalysis = useMemo(() => {
    const deptMap = {};
    yearlyData.forEach(record => {
      if (!deptMap[record.department]) {
        deptMap[record.department] = { total: 0, count: 0, scope1: 0, scope2: 0, scope3: 0 };
      }
      deptMap[record.department].total += record.emissionAmount;
      deptMap[record.department].count += 1;
      if (record.category === 'scope1') deptMap[record.department].scope1 += record.emissionAmount;
      if (record.category === 'scope2') deptMap[record.department].scope2 += record.emissionAmount;
      if (record.category === 'scope3') deptMap[record.department].scope3 += record.emissionAmount;
    });

    return Object.entries(deptMap).map(([name, data]) => ({
      name,
      total: parseFloat((data.total / 1000).toFixed(2)),
      count: data.count,
      scope1: parseFloat((data.scope1 / 1000).toFixed(2)),
      scope2: parseFloat((data.scope2 / 1000).toFixed(2)),
      scope3: parseFloat((data.scope3 / 1000).toFixed(2)),
    })).sort((a, b) => b.total - a.total);
  }, [yearlyData]);

  const handleExportPDF = async () => {
    setIsGenerating(true);
    try {
      const doc = new jsPDF();
      
      // Title
      doc.setFontSize(20);
      doc.text(`CarbonTrack Pro - ${selectedYear}年度碳排放报告`, 20, 20);
      
      // Summary
      doc.setFontSize(12);
      doc.text(`报告期间: ${selectedYear}年1月1日 - ${selectedYear}年12月31日`, 20, 35);
      doc.text(`总排放量: ${(getTotalEmissions(selectedYear) / 1000).toFixed(2)} 吨 CO₂eq`, 20, 45);
      doc.text(`数据记录数: ${yearlyData.length} 条`, 20, 55);
      
      // Monthly data table
      doc.autoTable({
        startY: 70,
        head: [['月份', '范围一', '范围二', '范围三', '合计']],
        body: monthlyData.map(m => [
          m.month,
          m.scope1.toFixed(2),
          m.scope2.toFixed(2),
          m.scope3.toFixed(2),
          m.total.toFixed(2),
        ]),
        theme: 'striped',
        headStyles: { fillColor: [25, 118, 210] },
      });
      
      // Save
      doc.save(`碳排放报告_${selectedYear}.pdf`);
      
      setSnackbar({
        open: true,
        message: 'PDF报告生成成功',
        severity: 'success',
      });
    } catch (error) {
      setSnackbar({
        open: true,
        message: 'PDF生成失败: ' + error.message,
        severity: 'error',
      });
    } finally {
      setIsGenerating(false);
    }
  };

  const handleExportExcel = async () => {
    setIsGenerating(true);
    try {
      const workbook = XLSX.utils.book_new();
      
      // Summary sheet
      const summaryData = [
        ['CarbonTrack Pro 碳排放报告', ''],
        ['报告期间', `${selectedYear}年`],
        ['总排放量 (吨 CO₂eq)', (getTotalEmissions(selectedYear) / 1000).toFixed(2)],
        ['数据记录数', yearlyData.length],
        [''],
        ['排放范围', '排放量 (吨)', '占比'],
        ...scopeBreakdown.map(s => [s.name, s.value, `${s.percentage}%`]),
      ];
      const summarySheet = XLSX.utils.aoa_to_sheet(summaryData);
      XLSX.utils.book_append_sheet(workbook, summarySheet, '汇总');
      
      // Monthly data sheet
      const monthlySheetData = [
        ['月份', '范围一', '范围二', '范围三', '合计'],
        ...monthlyData.map(m => [m.month, m.scope1, m.scope2, m.scope3, m.total]),
      ];
      const monthlySheet = XLSX.utils.aoa_to_sheet(monthlySheetData);
      XLSX.utils.book_append_sheet(workbook, monthlySheet, '月度数据');
      
      // Department data sheet
      const deptSheetData = [
        ['部门', '范围一', '范围二', '范围三', '合计', '记录数'],
        ...departmentAnalysis.map(d => [d.name, d.scope1, d.scope2, d.scope3, d.total, d.count]),
      ];
      const deptSheet = XLSX.utils.aoa_to_sheet(deptSheetData);
      XLSX.utils.book_append_sheet(workbook, deptSheet, '部门分析');
      
      // Raw data sheet
      const rawData = yearlyData.map(r => ({
        日期: r.date,
        排放范围: r.category,
        排放源: r.activityType,
        活动量: r.activityAmount,
        单位: r.unit,
        排放因子: r.emissionFactor,
        排放量_kg: r.emissionAmount.toFixed(2),
        排放量_吨: (r.emissionAmount / 1000).toFixed(2),
        部门: r.department,
        备注: r.notes || '',
      }));
      const rawSheet = XLSX.utils.json_to_sheet(rawData);
      XLSX.utils.book_append_sheet(workbook, rawSheet, '原始数据');
      
      // Save
      XLSX.writeFile(workbook, `碳排放报告_${selectedYear}.xlsx`);
      
      setSnackbar({
        open: true,
        message: 'Excel报告生成成功',
        severity: 'success',
      });
    } catch (error) {
      setSnackbar({
        open: true,
        message: 'Excel生成失败: ' + error.message,
        severity: 'error',
      });
    } finally {
      setIsGenerating(false);
    }
  };

  const handlePrint = () => {
    window.print();
  };

  return (
    <Container maxWidth="xl" sx={{ mt: 4, mb: 4 }}>
      <Typography variant="h4" component="h1" gutterBottom>
        碳排放报告
      </Typography>

      {/* Report Configuration */}
      <Paper sx={{ p: 3, mb: 3 }}>
        <Grid container spacing={3} alignItems="center">
          <Grid item xs={12} sm={6} md={3}>
            <FormControl fullWidth>
              <InputLabel>报告类型</InputLabel>
              <Select
                value={reportType}
                onChange={(e) => setReportType(e.target.value)}
                label="报告类型"
              >
                <MenuItem value="annual">年度报告</MenuItem>
                <MenuItem value="monthly">月度报告</MenuItem>
                <MenuItem value="quarterly">季度报告</MenuItem>
                <MenuItem value="custom">自定义报告</MenuItem>
              </Select>
            </FormControl>
          </Grid>
          <Grid item xs={12} sm={6} md={3}>
            <FormControl fullWidth>
              <InputLabel>年份</InputLabel>
              <Select
                value={selectedYear}
                onChange={(e) => setSelectedYear(e.target.value)}
                label="年份"
              >
                {years.map(year => (
                  <MenuItem key={year} value={year}>{year}年</MenuItem>
                ))}
              </Select>
            </FormControl>
          </Grid>
          <Grid item xs={12} sm={6} md={6}>
            <Box display="flex" gap={1}>
              <Button
                variant="contained"
                startIcon={isGenerating ? <CircularProgress size={20} /> : <PdfIcon />}
                onClick={handleExportPDF}
                disabled={isGenerating}
              >
                导出 PDF
              </Button>
              <Button
                variant="contained"
                color="success"
                startIcon={isGenerating ? <CircularProgress size={20} /> : <ExcelIcon />}
                onClick={handleExportExcel}
                disabled={isGenerating}
              >
                导出 Excel
              </Button>
              <Button
                variant="outlined"
                startIcon={<PrintIcon />}
                onClick={handlePrint}
              >
                打印
              </Button>
            </Box>
          </Grid>
        </Grid>
      </Paper>

      {/* Report Content Tabs */}
      <Paper sx={{ mb: 3 }}>
        <Tabs value={activeTab} onChange={(e, v) => setActiveTab(v)}>
          <Tab label="排放总览" />
          <Tab label="月度趋势" />
          <Tab label="范围分析" />
          <Tab label="部门分析" />
          <Tab label="原始数据" />
        </Tabs>

        {/* Tab 0: Overview */}
        {activeTab === 0 && (
          <Box p={3}>
            <Grid container spacing={3}>
              <Grid item xs={12} md={8}>
                <Typography variant="h6" gutterBottom>
                  {selectedYear}年碳排放总览
                </Typography>
                <Card variant="outlined" sx={{ mb: 2 }}>
                  <CardContent>
                    <Grid container spacing={2}>
                      <Grid item xs={6} md={3}>
                        <Typography variant="body2" color="textSecondary">总排放量</Typography>
                        <Typography variant="h4" color="primary">
                          {(getTotalEmissions(selectedYear) / 1000).toFixed(2)}
                        </Typography>
                        <Typography variant="body2" color="textSecondary">吨 CO₂eq</Typography>
                      </Grid>
                      <Grid item xs={6} md={3}>
                        <Typography variant="body2" color="textSecondary">范围一</Typography>
                        <Typography variant="h4" color="error">
                          {scopeBreakdown[0]?.value || 0}
                        </Typography>
                        <Typography variant="body2" color="textSecondary">吨 CO₂eq</Typography>
                      </Grid>
                      <Grid item xs={6} md={3}>
                        <Typography variant="body2" color="textSecondary">范围二</Typography>
                        <Typography variant="h4" color="primary">
                          {scopeBreakdown[1]?.value || 0}
                        </Typography>
                        <Typography variant="body2" color="textSecondary">吨 CO₂eq</Typography>
                      </Grid>
                      <Grid item xs={6} md={3}>
                        <Typography variant="body2" color="textSecondary">范围三</Typography>
                        <Typography variant="h4" color="warning.main">
                          {scopeBreakdown[2]?.value || 0}
                        </Typography>
                        <Typography variant="body2" color="textSecondary">吨 CO₂eq</Typography>
                      </Grid>
                    </Grid>
                  </CardContent>
                </Card>

                <ResponsiveContainer width="100%" height={400}>
                  <AreaChart data={monthlyData}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="month" />
                    <YAxis label={{ value: '吨 CO₂eq', angle: -90, position: 'insideLeft' }} />
                    <Tooltip />
                    <Legend />
                    <Area type="monotone" dataKey="scope1" name="范围一" stackId="1" fill="#ff5252" />
                    <Area type="monotone" dataKey="scope2" name="范围二" stackId="1" fill="#1976d2" />
                    <Area type="monotone" dataKey="scope3" name="范围三" stackId="1" fill="#ff9800" />
                  </AreaChart>
                </ResponsiveContainer>
              </Grid>

              <Grid item xs={12} md={4}>
                <Typography variant="h6" gutterBottom>
                  排放范围占比
                </Typography>
                <ResponsiveContainer width="100%" height={300}>
                  <PieChart>
                    <Pie
                      data={scopeBreakdown}
                      cx="50%"
                      cy="50%"
                      labelLine={false}
                      label={(entry) => `${entry.name}: ${entry.value}吨`}
                      outerRadius={100}
                      fill="#8884d8"
                      dataKey="value"
                    >
                      {scopeBreakdown.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>

                <Typography variant="h6" gutterBottom sx={{ mt: 3 }}>
                  关键指标
                </Typography>
                <TableContainer>
                  <Table size="small">
                    <TableBody>
                      <TableRow>
                        <TableCell>数据完整度</TableCell>
                        <TableCell align="right">87%</TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell>同比变化</TableCell>
                        <TableCell align="right" sx={{ color: 'error.main' }}>+12.5%</TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell>月度平均</TableCell>
                        <TableCell align="right">
                          {((getTotalEmissions(selectedYear) / 1000 / 12).toFixed(2))} 吨
                        </TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell>最大月份</TableCell>
                        <TableCell align="right">
                          {monthlyData.reduce((max, m) => m.total > max.total ? m : max).month}
                        </TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                </TableContainer>
              </Grid>
            </Grid>
          </Box>
        )}

        {/* Tab 1: Monthly Trend */}
        {activeTab === 1 && (
          <Box p={3}>
            <Typography variant="h6" gutterBottom>
              月度排放趋势
            </Typography>
            <ResponsiveContainer width="100%" height={500}>
              <LineChart data={monthlyData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="month" />
                <YAxis yAxisId="left" label={{ value: '吨 CO₂eq', angle: -90, position: 'insideLeft' }} />
                <YAxis yAxisId="right" orientation="right" label={{ value: '累计 (吨)', angle: 90, position: 'insideRight' }} />
                <Tooltip />
                <Legend />
                <Line yAxisId="left" type="monotone" dataKey="scope1" name="范围一" stroke="#ff5252" />
                <Line yAxisId="left" type="monotone" dataKey="scope2" name="范围二" stroke="#1976d2" />
                <Line yAxisId="left" type="monotone" dataKey="scope3" name="范围三" stroke="#ff9800" />
                <Line yAxisId="left" type="monotone" dataKey="total" name="总计" stroke="#000" strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>

            <TableContainer sx={{ mt: 3 }}>
              <Table>
                <TableHead>
                  <TableRow>
                    <TableCell>月份</TableCell>
                    <TableCell align="right">范围一 (吨)</TableCell>
                    <TableCell align="right">范围二 (吨)</TableCell>
                    <TableCell align="right">范围三 (吨)</TableCell>
                    <TableCell align="right">合计 (吨)</TableCell>
                    <TableCell align="right">环比变化</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {monthlyData.map((month, index) => (
                    <TableRow key={month.month}>
                      <TableCell>{month.month}</TableCell>
                      <TableCell align="right">{month.scope1.toFixed(2)}</TableCell>
                      <TableCell align="right">{month.scope2.toFixed(2)}</TableCell>
                      <TableCell align="right">{month.scope3.toFixed(2)}</TableCell>
                      <TableCell align="right">{month.total.toFixed(2)}</TableCell>
                      <TableCell align="right">
                        {index > 0 ? (
                          <span style={{ 
                            color: month.total > monthlyData[index-1].total ? '#f44336' : '#4caf50' 
                          }}>
                            {(((month.total - monthlyData[index-1].total) / monthlyData[index-1].total) * 100).toFixed(1)}%
                          </span>
                        ) : '-'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </Box>
        )}

        {/* Tab 2: Scope Analysis */}
        {activeTab === 2 && (
          <Box p={3}>
            <Typography variant="h6" gutterBottom>
              排放范围分析
            </Typography>
            <Grid container spacing={3}>
              {scopeBreakdown.map((scope, index) => (
                <Grid item xs={12} md={4} key={scope.name}>
                  <Card variant="outlined">
                    <CardContent>
                      <Typography variant="h6" color={COLORS[index]} gutterBottom>
                        {scope.name}
                      </Typography>
                      <Typography variant="h3" gutterBottom>
                        {scope.value}
                      </Typography>
                      <Typography variant="body2" color="textSecondary">
                        吨 CO₂eq ({scope.percentage}%)
                      </Typography>
                      <Divider sx={{ my: 2 }} />
                      <Typography variant="body2">
                        {scope.name === '范围一 (直接排放)' && '包括: 燃料燃烧、工业过程、逸散排放等'}
                        {scope.name === '范围二 (能源间接排放)' && '包括: 外购电力、热力、蒸汽等'}
                        {scope.name === '范围三 (其他间接排放)' && '包括: 商务差旅、废弃物处理、员工通勤等'}
                      </Typography>
                    </CardContent>
                  </Card>
                </Grid>
              ))}
            </Grid>
          </Box>
        )}

        {/* Tab 3: Department Analysis */}
        {activeTab === 3 && (
          <Box p={3}>
            <Typography variant="h6" gutterBottom>
              部门排放分析
            </Typography>
            <TableContainer>
              <Table>
                <TableHead>
                  <TableRow>
                    <TableCell>部门</TableCell>
                    <TableCell align="right">范围一 (吨)</TableCell>
                    <TableCell align="right">范围二 (吨)</TableCell>
                    <TableCell align="right">范围三 (吨)</TableCell>
                    <TableCell align="right">合计 (吨)</TableCell>
                    <TableCell align="right">记录数</TableCell>
                    <TableCell align="right">占比</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {departmentAnalysis.map((dept) => (
                    <TableRow key={dept.name}>
                      <TableCell>{dept.name}</TableCell>
                      <TableCell align="right">{dept.scope1.toFixed(2)}</TableCell>
                      <TableCell align="right">{dept.scope2.toFixed(2)}</TableCell>
                      <TableCell align="right">{dept.scope3.toFixed(2)}</TableCell>
                      <TableCell align="right" sx={{ fontWeight: 'bold' }}>
                        {dept.total.toFixed(2)}
                      </TableCell>
                      <TableCell align="right">{dept.count}</TableCell>
                      <TableCell align="right">
                        {((dept.total / (getTotalEmissions(selectedYear) / 1000)) * 100).toFixed(1)}%
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </Box>
        )}

        {/* Tab 4: Raw Data */}
        {activeTab === 4 && (
          <Box p={3}>
            <Typography variant="h6" gutterBottom>
              原始数据 ({yearlyData.length} 条记录)
            </Typography>
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>日期</TableCell>
                    <TableCell>排放范围</TableCell>
                    <TableCell>排放源</TableCell>
                    <TableCell align="right">活动量</TableCell>
                    <TableCell align="right">排放因子</TableCell>
                    <TableCell align="right">排放量 (kg)</TableCell>
                    <TableCell>部门</TableCell>
                    <TableCell>备注</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {yearlyData.slice(0, 100).map((record) => (
                    <TableRow key={record.id}>
                      <TableCell>{record.date}</TableCell>
                      <TableCell>{record.category}</TableCell>
                      <TableCell>{record.activityType}</TableCell>
                      <TableCell align="right">
                        {record.activityAmount} {record.unit}
                      </TableCell>
                      <TableCell align="right">{record.emissionFactor}</TableCell>
                      <TableCell align="right">{record.emissionAmount.toFixed(2)}</TableCell>
                      <TableCell>{record.department}</TableCell>
                      <TableCell>{record.notes || '-'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
            {yearlyData.length > 100 && (
              <Alert severity="info" sx={{ mt: 2 }}>
                仅显示前 100 条记录，导出报告可查看完整数据
              </Alert>
            )}
          </Box>
        )}
      </Paper>

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

export default Reports;
