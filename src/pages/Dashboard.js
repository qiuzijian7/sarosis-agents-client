import React, { useState, useEffect, useMemo } from 'react';
import {
  Container,
  Grid,
  Paper,
  Typography,
  Box,
  Card,
  CardContent,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Button,
  IconButton,
  Tooltip,
} from '@mui/material';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as ReTooltip,
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
import { zhCN } from 'date-fns/locale';
import DownloadIcon from '@mui/icons-material/Download';
import FileUploadIcon from '@mui/icons-material/FileUpload';

const COLORS = ['#0088FE', '#00C49F', '#FFBB28', '#FF8042', '#8884D8'];

function Dashboard() {
  const { emissionData, getYearlyEmissions, getTotalEmissions } = useEmission();
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());
  const [viewMode, setViewMode] = useState('monthly'); // monthly, quarterly, yearly

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
      
      return {
        month: format(month, 'M月'),
        emission: parseFloat((totalEmission / 1000).toFixed(2)), // Convert to tons
        count: monthData.length,
      };
    });
  }, [yearlyData, selectedYear]);

  const scopeData = useMemo(() => {
    const scope1 = yearlyData
      .filter(r => r.category === 'scope1')
      .reduce((sum, r) => sum + r.emissionAmount, 0);
    const scope2 = yearlyData
      .filter(r => r.category === 'scope2')
      .reduce((sum, r) => sum + r.emissionAmount, 0);
    const scope3 = yearlyData
      .filter(r => r.category === 'scope3')
      .reduce((sum, r) => sum + r.emissionAmount, 0);

    return [
      { name: '范围一 (直接排放)', value: parseFloat((scope1 / 1000).toFixed(2)) },
      { name: '范围二 (能源间接排放)', value: parseFloat((scope2 / 1000).toFixed(2)) },
      { name: '范围三 (其他间接排放)', value: parseFloat((scope3 / 1000).toFixed(2)) },
    ];
  }, [yearlyData]);

  const departmentData = useMemo(() => {
    const deptMap = {};
    yearlyData.forEach(record => {
      if (!deptMap[record.department]) {
        deptMap[record.department] = 0;
      }
      deptMap[record.department] += record.emissionAmount;
    });

    return Object.entries(deptMap).map(([name, value]) => ({
      name,
      value: parseFloat((value / 1000).toFixed(2)),
    }));
  }, [yearlyData]);

  const totalEmission = useMemo(() => {
    return getTotalEmissions(selectedYear) / 1000; // Convert to tons
  }, [selectedYear, emissionData]);

  const topActivities = useMemo(() => {
    const activityMap = {};
    yearlyData.forEach(record => {
      if (!activityMap[record.activityType]) {
        activityMap[record.activityType] = {
          type: record.activityType,
          total: 0,
          count: 0,
        };
      }
      activityMap[record.activityType].total += record.emissionAmount;
      activityMap[record.activityType].count += 1;
    });

    return Object.values(activityMap)
      .sort((a, b) => b.total - a.total)
      .slice(0, 5)
      .map(item => ({
        ...item,
        total: parseFloat((item.total / 1000).toFixed(2)),
      }));
  }, [yearlyData]);

  const handleExport = () => {
    // Export functionality will be implemented here
    console.log('Exporting data...');
  };

  return (
    <Container maxWidth="xl" sx={{ mt: 4, mb: 4 }}>
      <Box display="flex" justifyContent="space-between" alignItems="center" mb={3}>
        <Typography variant="h4" component="h1">
          碳排放管理驾驶舱
        </Typography>
        <Box>
          <FormControl sx={{ minWidth: 120, mr: 2 }}>
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
          <Tooltip title="导出报告">
            <IconButton onClick={handleExport} color="primary">
              <DownloadIcon />
            </IconButton>
          </Tooltip>
        </Box>
      </Box>

      {/* KPI Cards */}
      <Grid container spacing={3} mb={3}>
        <Grid item xs={12} sm={6} md={3}>
          <Card>
            <CardContent>
              <Typography color="textSecondary" gutterBottom>
                年度总排放量
              </Typography>
              <Typography variant="h4">
                {totalEmission.toFixed(2)}
              </Typography>
              <Typography variant="body2" color="textSecondary">
                吨 CO₂eq
              </Typography>
            </CardContent>
          </Card>
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <Card>
            <CardContent>
              <Typography color="textSecondary" gutterBottom>
                数据完整度
              </Typography>
              <Typography variant="h4" color="success.main">
                87%
              </Typography>
              <Typography variant="body2" color="textSecondary">
                较上月 +5%
              </Typography>
            </CardContent>
          </Card>
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <Card>
            <CardContent>
              <Typography color="textSecondary" gutterBottom>
                异常预警
              </Typography>
              <Typography variant="h4" color="warning.main">
                3
              </Typography>
              <Typography variant="body2" color="textSecondary">
                项待处理
              </Typography>
            </CardContent>
          </Card>
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <Card>
            <CardContent>
              <Typography color="textSecondary" gutterBottom>
                同比变化
              </Typography>
              <Typography variant="h4" color="error.main">
                +12.5%
              </Typography>
              <Typography variant="body2" color="textSecondary">
                较去年
              </Typography>
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      {/* Charts Row 1 */}
      <Grid container spacing={3} mb={3}>
        <Grid item xs={12} md={8}>
          <Paper sx={{ p: 3 }}>
            <Typography variant="h6" gutterBottom>
              月度排放趋势
            </Typography>
            <ResponsiveContainer width="100%" height={400}>
              <BarChart data={monthlyData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="month" />
                <YAxis label={{ value: '吨 CO₂eq', angle: -90, position: 'insideLeft' }} />
                <ReTooltip />
                <Legend />
                <Bar dataKey="emission" name="排放量" fill="#1976d2" />
              </BarChart>
            </ResponsiveContainer>
          </Paper>
        </Grid>
        <Grid item xs={12} md={4}>
          <Paper sx={{ p: 3 }}>
            <Typography variant="h6" gutterBottom>
              排放范围分布
            </Typography>
            <ResponsiveContainer width="100%" height={400}>
              <PieChart>
                <Pie
                  data={scopeData}
                  cx="50%"
                  cy="50%"
                  labelLine={false}
                  label={(entry) => `${entry.name}: ${entry.value}吨`}
                  outerRadius={120}
                  fill="#8884d8"
                  dataKey="value"
                >
                  {scopeData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Pie>
                <ReTooltip />
              </PieChart>
            </ResponsiveContainer>
          </Paper>
        </Grid>
      </Grid>

      {/* Charts Row 2 */}
      <Grid container spacing={3} mb={3}>
        <Grid item xs={12} md={6}>
          <Paper sx={{ p: 3 }}>
            <Typography variant="h6" gutterBottom>
              部门排放排名
            </Typography>
            <ResponsiveContainer width="100%" height={400}>
              <BarChart data={departmentData} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis type="number" label={{ value: '吨 CO₂eq', position: 'insideBottom', offset: -5 }} />
                <YAxis dataKey="name" type="category" width={80} />
                <ReTooltip />
                <Bar dataKey="value" name="排放量" fill="#82ca9d" />
              </BarChart>
            </ResponsiveContainer>
          </Paper>
        </Grid>
        <Grid item xs={12} md={6}>
          <Paper sx={{ p: 3 }}>
            <Typography variant="h6" gutterBottom>
              主要排放源 TOP 5
            </Typography>
            <TableContainer>
              <Table>
                <TableHead>
                  <TableRow>
                    <TableCell>排放源</TableCell>
                    <TableCell align="right">排放量 (吨)</TableCell>
                    <TableCell align="right">记录数</TableCell>
                    <TableCell align="right">占比</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {topActivities.map((activity, index) => (
                    <TableRow key={activity.type}>
                      <TableCell>{activity.type}</TableCell>
                      <TableCell align="right">{activity.total}</TableCell>
                      <TableCell align="right">{activity.count}</TableCell>
                      <TableCell align="right">
                        {((activity.total / totalEmission) * 100).toFixed(1)}%
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </Paper>
        </Grid>
      </Grid>

      {/* Recent Activities */}
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
                <TableCell>排放量 (kg)</TableCell>
                <TableCell>部门</TableCell>
                <TableCell>状态</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {yearlyData.slice(0, 10).map((record) => (
                <TableRow key={record.id}>
                  <TableCell>{record.date}</TableCell>
                  <TableCell>{record.activityType}</TableCell>
                  <TableCell>{record.activityAmount} {record.unit}</TableCell>
                  <TableCell>{record.emissionAmount.toFixed(2)}</TableCell>
                  <TableCell>{record.department}</TableCell>
                  <TableCell>
                    <Box
                      sx={{
                        bgcolor: 'success.light',
                        color: 'success.contrastText',
                        px: 1,
                        py: 0.5,
                        borderRadius: 1,
                        display: 'inline-block',
                      }}
                    >
                      已验证
                    </Box>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>
    </Container>
  );
}

export default Dashboard;
