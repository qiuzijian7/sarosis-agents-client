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
  TablePagination,
  IconButton,
  Tooltip,
  Chip,
  Alert,
  Snackbar,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Card,
  CardContent,
  InputAdornment,
  Menu,
} from '@mui/material';
import {
  FilterList as FilterIcon,
  Download as DownloadIcon,
  Upload as UploadIcon,
  Edit as EditIcon,
  Delete as DeleteIcon,
  Visibility as ViewIcon,
  MoreVert as MoreIcon,
  CheckCircle as VerifyIcon,
  Flag as FlagIcon,
} from '@mui/icons-material';
import { useEmission } from '../context/EmissionContext';
import { format, startOfMonth, endOfMonth, parseISO } from 'date-fns';

function DataManagement() {
  const { emissionData, updateEmissionRecord, deleteEmissionRecord } = useEmission();
  
  // Filters
  const [filters, setFilters] = useState({
    dateRange: 'all',
    startDate: '',
    endDate: '',
    category: 'all',
    department: 'all',
    status: 'all',
    search: '',
  });
  
  // Pagination
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(10);
  
  // Selection
  const [selectedRows, setSelectedRows] = useState([]);
  
  // Dialogs
  const [viewDialog, setViewDialog] = useState({ open: false, record: null });
  const [editDialog, setEditDialog] = useState({ open: false, record: null });
  const [deleteDialog, setDeleteDialog] = useState({ open: false, id: null });
  
  // Anchor for action menu
  const [anchorEl, setAnchorEl] = useState(null);
  const [selectedRecord, setSelectedRecord] = useState(null);
  
  // Snackbar
  const [snackbar, setSnackbar] = useState({ open: false, message: '', severity: 'success' });

  const filteredData = useMemo(() => {
    let data = [...emissionData];
    
    // Date range filter
    if (filters.dateRange === 'custom' && filters.startDate && filters.endDate) {
      data = data.filter(record => {
        const recordDate = parseISO(record.date);
        return recordDate >= parseISO(filters.startDate) && 
               recordDate <= parseISO(filters.endDate);
      });
    } else if (filters.dateRange === 'thisMonth') {
      const now = new Date();
      const start = startOfMonth(now);
      const end = endOfMonth(now);
      data = data.filter(record => {
        const recordDate = parseISO(record.date);
        return recordDate >= start && recordDate <= end;
      });
    }
    
    // Category filter
    if (filters.category !== 'all') {
      data = data.filter(record => record.category === filters.category);
    }
    
    // Department filter
    if (filters.department !== 'all') {
      data = data.filter(record => record.department === filters.department);
    }
    
    // Search filter
    if (filters.search) {
      const searchLower = filters.search.toLowerCase();
      data = data.filter(record => 
        record.activityType.toLowerCase().includes(searchLower) ||
        record.department.toLowerCase().includes(searchLower) ||
        record.notes?.toLowerCase().includes(searchLower)
      );
    }
    
    // Sort by date descending
    data.sort((a, b) => new Date(b.date) - new Date(a.date));
    
    return data;
  }, [emissionData, filters]);

  const handleFilterChange = (field, value) => {
    setFilters(prev => ({ ...prev, [field]: value }));
    setPage(0);
  };

  const handleSelectAll = (event) => {
    if (event.target.checked) {
      setSelectedRows(filteredData.map(record => record.id));
    } else {
      setSelectedRows([]);
    }
  };

  const handleSelectRow = (id) => {
    if (selectedRows.includes(id)) {
      setSelectedRows(selectedRows.filter(rowId => rowId !== id));
    } else {
      setSelectedRows([...selectedRows, id]);
    }
  };

  const handleEdit = (record) => {
    setEditDialog({ open: true, record: { ...record } });
  };

  const handleEditSave = () => {
    updateEmissionRecord(editDialog.record.id, editDialog.record);
    setEditDialog({ open: false, record: null });
    setSnackbar({
      open: true,
      message: '记录更新成功',
      severity: 'success',
    });
  };

  const handleDelete = (id) => {
    setDeleteDialog({ open: true, id });
  };

  const confirmDelete = () => {
    deleteEmissionRecord(deleteDialog.id);
    setDeleteDialog({ open: false, id: null });
    setSnackbar({
      open: true,
      message: '记录已删除',
      severity: 'info',
    });
  };

  const handleVerify = (id) => {
    updateEmissionRecord(id, { status: 'verified' });
    setSnackbar({
      open: true,
      message: '记录已验证',
      severity: 'success',
    });
  };

  const handleBatchVerify = () => {
    selectedRows.forEach(id => {
      updateEmissionRecord(id, { status: 'verified' });
    });
    setSelectedRows([]);
    setSnackbar({
      open: true,
      message: `已验证 ${selectedRows.length} 条记录`,
      severity: 'success',
    });
  };

  const handleExport = () => {
    const exportData = filteredData.map(record => ({
      日期: record.date,
      排放范围: record.category,
      排放源类型: record.activityType,
      活动量: record.activityAmount,
      单位: record.unit,
      排放因子: record.emissionFactor,
      排放量_kg: record.emissionAmount.toFixed(2),
      部门: record.department,
      状态: record.status || 'draft',
      备注: record.notes || '',
    }));

    const csv = [
      Object.keys(exportData[0]).join(','),
      ...exportData.map(row => Object.values(row).join(',')),
    ].join('\n');

    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `碳排放数据_${format(new Date(), 'yyyyMMdd')}.csv`;
    link.click();
    
    setSnackbar({
      open: true,
      message: '数据导出成功',
      severity: 'success',
    });
  };

  const handleActionClick = (event, record) => {
    setAnchorEl(event.currentTarget);
    setSelectedRecord(record);
  };

  const handleActionClose = () => {
    setAnchorEl(null);
    setSelectedRecord(null);
  };

  return (
    <Container maxWidth="xl" sx={{ mt: 4, mb: 4 }}>
      <Typography variant="h4" component="h1" gutterBottom>
        数据管理
      </Typography>

      {/* Filters */}
      <Paper sx={{ p: 2, mb: 3 }}>
        <Grid container spacing={2} alignItems="center">
          <Grid item xs={12} sm={6} md={3}>
            <FormControl fullWidth size="small">
              <InputLabel>时间范围</InputLabel>
              <Select
                value={filters.dateRange}
                onChange={(e) => handleFilterChange('dateRange', e.target.value)}
                label="时间范围"
              >
                <MenuItem value="all">全部</MenuItem>
                <MenuItem value="thisMonth">本月</MenuItem>
                <MenuItem value="lastMonth">上月</MenuItem>
                <MenuItem value="thisYear">今年</MenuItem>
                <MenuItem value="custom">自定义</MenuItem>
              </Select>
            </FormControl>
          </Grid>
          
          {filters.dateRange === 'custom' && (
            <>
              <Grid item xs={12} sm={6} md={2}>
                <TextField
                  fullWidth
                  size="small"
                  label="开始日期"
                  type="date"
                  value={filters.startDate}
                  onChange={(e) => handleFilterChange('startDate', e.target.value)}
                  InputLabelProps={{ shrink: true }}
                />
              </Grid>
              <Grid item xs={12} sm={6} md={2}>
                <TextField
                  fullWidth
                  size="small"
                  label="结束日期"
                  type="date"
                  value={filters.endDate}
                  onChange={(e) => handleFilterChange('endDate', e.target.value)}
                  InputLabelProps={{ shrink: true }}
                />
              </Grid>
            </>
          )}
          
          <Grid item xs={12} sm={6} md={2}>
            <FormControl fullWidth size="small">
              <InputLabel>排放范围</InputLabel>
              <Select
                value={filters.category}
                onChange={(e) => handleFilterChange('category', e.target.value)}
                label="排放范围"
              >
                <MenuItem value="all">全部</MenuItem>
                <MenuItem value="scope1">范围一</MenuItem>
                <MenuItem value="scope2">范围二</MenuItem>
                <MenuItem value="scope3">范围三</MenuItem>
              </Select>
            </FormControl>
          </Grid>
          
          <Grid item xs={12} sm={6} md={2}>
            <FormControl fullWidth size="small">
              <InputLabel>部门</InputLabel>
              <Select
                value={filters.department}
                onChange={(e) => handleFilterChange('department', e.target.value)}
                label="部门"
              >
                <MenuItem value="all">全部</MenuItem>
                <MenuItem value="生产部">生产部</MenuItem>
                <MenuItem value="行政部">行政部</MenuItem>
                <MenuItem value="研发部">研发部</MenuItem>
                <MenuItem value="市场部">市场部</MenuItem>
              </Select>
            </FormControl>
          </Grid>
          
          <Grid item xs={12} sm={6} md={3}>
            <TextField
              fullWidth
              size="small"
              label="搜索"
              value={filters.search}
              onChange={(e) => handleFilterChange('search', e.target.value)}
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <FilterIcon fontSize="small" />
                  </InputAdornment>
                ),
              }}
            />
          </Grid>
        </Grid>
      </Paper>

      {/* Actions Bar */}
      <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
        <Typography variant="body2" color="textSecondary">
          共 {filteredData.length} 条记录
          {selectedRows.length > 0 && ` (已选择 ${selectedRows.length} 条)`}
        </Typography>
        <Box>
          {selectedRows.length > 0 && (
            <Button
              variant="contained"
              color="success"
              startIcon={<VerifyIcon />}
              onClick={handleBatchVerify}
              sx={{ mr: 1 }}
            >
              批量验证
            </Button>
          )}
          <Button
            variant="outlined"
            startIcon={<DownloadIcon />}
            onClick={handleExport}
          >
            导出
          </Button>
        </Box>
      </Box>

      {/* Data Table */}
      <Paper sx={{ mb: 3 }}>
        <TableContainer>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell padding="checkbox">
                  <input
                    type="checkbox"
                    onChange={handleSelectAll}
                    checked={selectedRows.length === filteredData.length && filteredData.length > 0}
                  />
                </TableCell>
                <TableCell>日期</TableCell>
                <TableCell>排放范围</TableCell>
                <TableCell>排放源</TableCell>
                <TableCell align="right">活动量</TableCell>
                <TableCell align="right">排放量 (kg)</TableCell>
                <TableCell>部门</TableCell>
                <TableCell>状态</TableCell>
                <TableCell>操作</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {filteredData
                .slice(page * rowsPerPage, page * rowsPerPage + rowsPerPage)
                .map((record) => (
                  <TableRow key={record.id} hover>
                    <TableCell padding="checkbox">
                      <input
                        type="checkbox"
                        checked={selectedRows.includes(record.id)}
                        onChange={() => handleSelectRow(record.id)}
                      />
                    </TableCell>
                    <TableCell>{record.date}</TableCell>
                    <TableCell>
                      <Chip
                        label={record.category === 'scope1' ? '范围一' :
                               record.category === 'scope2' ? '范围二' : '范围三'}
                        size="small"
                        color={record.category === 'scope1' ? 'error' :
                               record.category === 'scope2' ? 'primary' : 'warning'}
                      />
                    </TableCell>
                    <TableCell>{record.activityType}</TableCell>
                    <TableCell align="right">
                      {record.activityAmount} {record.unit}
                    </TableCell>
                    <TableCell align="right">
                      {record.emissionAmount.toFixed(2)}
                    </TableCell>
                    <TableCell>{record.department}</TableCell>
                    <TableCell>
                      <Chip
                        label={record.status === 'verified' ? '已验证' : '草稿'}
                        size="small"
                        color={record.status === 'verified' ? 'success' : 'default'}
                      />
                    </TableCell>
                    <TableCell>
                      <Tooltip title="查看">
                        <IconButton
                          size="small"
                          onClick={() => setViewDialog({ open: true, record })}
                        >
                          <ViewIcon />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="编辑">
                        <IconButton
                          size="small"
                          onClick={() => handleEdit(record)}
                        >
                          <EditIcon />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="更多">
                        <IconButton
                          size="small"
                          onClick={(e) => handleActionClick(e, record)}
                        >
                          <MoreIcon />
                        </IconButton>
                      </Tooltip>
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </TableContainer>
        <TablePagination
          rowsPerPageOptions={[10, 25, 50, 100]}
          component="div"
          count={filteredData.length}
          rowsPerPage={rowsPerPage}
          page={page}
          onPageChange={(e, newPage) => setPage(newPage)}
          onRowsPerPageChange={(e) => {
            setRowsPerPage(parseInt(e.target.value, 10));
            setPage(0);
          }}
        />
      </Paper>

      {/* Action Menu */}
      <Menu
        anchorEl={anchorEl}
        open={Boolean(anchorEl)}
        onClose={handleActionClose}
      >
        <MenuItem onClick={() => {
          handleVerify(selectedRecord?.id);
          handleActionClose();
        }}>
          <VerifyIcon fontSize="small" sx={{ mr: 1 }} />
          验证
        </MenuItem>
        <MenuItem onClick={() => {
          handleDelete(selectedRecord?.id);
          handleActionClose();
        }}>
          <DeleteIcon fontSize="small" sx={{ mr: 1 }} />
          删除
        </MenuItem>
        <MenuItem onClick={() => {
          // Flag for review
          updateEmissionRecord(selectedRecord?.id, { flagged: true });
          handleActionClose();
          setSnackbar({
            open: true,
            message: '已标记待审核',
            severity: 'info',
          });
        }}>
          <FlagIcon fontSize="small" sx={{ mr: 1 }} />
          标记审核
        </MenuItem>
      </Menu>

      {/* View Dialog */}
      <Dialog
        open={viewDialog.open}
        onClose={() => setViewDialog({ open: false, record: null })}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>查看记录详情</DialogTitle>
        <DialogContent>
          {viewDialog.record && (
            <Grid container spacing={2} sx={{ mt: 1 }}>
              <Grid item xs={6}>
                <Typography variant="body2" color="textSecondary">日期</Typography>
                <Typography variant="body1">{viewDialog.record.date}</Typography>
              </Grid>
              <Grid item xs={6}>
                <Typography variant="body2" color="textSecondary">排放源</Typography>
                <Typography variant="body1">{viewDialog.record.activityType}</Typography>
              </Grid>
              <Grid item xs={6}>
                <Typography variant="body2" color="textSecondary">活动量</Typography>
                <Typography variant="body1">
                  {viewDialog.record.activityAmount} {viewDialog.record.unit}
                </Typography>
              </Grid>
              <Grid item xs={6}>
                <Typography variant="body2" color="textSecondary">排放量</Typography>
                <Typography variant="body1">
                  {viewDialog.record.emissionAmount.toFixed(2)} kg CO₂eq
                </Typography>
              </Grid>
              <Grid item xs={12}>
                <Typography variant="body2" color="textSecondary">备注</Typography>
                <Typography variant="body1">{viewDialog.record.notes || '无'}</Typography>
              </Grid>
            </Grid>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setViewDialog({ open: false, record: null })}>关闭</Button>
        </DialogActions>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog
        open={editDialog.open}
        onClose={() => setEditDialog({ open: false, record: null })}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>编辑记录</DialogTitle>
        <DialogContent>
          {editDialog.record && (
            <Grid container spacing={2} sx={{ mt: 1 }}>
              <Grid item xs={12} sm={6}>
                <TextField
                  fullWidth
                  label="日期"
                  type="date"
                  value={editDialog.record.date}
                  onChange={(e) => setEditDialog({
                    ...editDialog,
                    record: { ...editDialog.record, date: e.target.value }
                  })}
                  InputLabelProps={{ shrink: true }}
                />
              </Grid>
              <Grid item xs={12} sm={6}>
                <TextField
                  fullWidth
                  label="活动量"
                  type="number"
                  value={editDialog.record.activityAmount}
                  onChange={(e) => setEditDialog({
                    ...editDialog,
                    record: { ...editDialog.record, activityAmount: parseFloat(e.target.value) }
                  })}
                  InputProps={{
                    endAdornment: (
                      <InputAdornment position="end">
                        {editDialog.record.unit}
                      </InputAdornment>
                    ),
                  }}
                />
              </Grid>
              <Grid item xs={12}>
                <TextField
                  fullWidth
                  label="备注"
                  multiline
                  rows={3}
                  value={editDialog.record.notes || ''}
                  onChange={(e) => setEditDialog({
                    ...editDialog,
                    record: { ...editDialog.record, notes: e.target.value }
                  })}
                />
              </Grid>
            </Grid>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditDialog({ open: false, record: null })}>取消</Button>
          <Button onClick={handleEditSave} variant="contained">保存</Button>
        </DialogActions>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog
        open={deleteDialog.open}
        onClose={() => setDeleteDialog({ open: false, id: null })}
      >
        <DialogTitle>确认删除</DialogTitle>
        <DialogContent>
          <Typography>确定要删除这条记录吗？此操作不可撤销。</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteDialog({ open: false, id: null })}>取消</Button>
          <Button onClick={confirmDelete} color="error" variant="contained">删除</Button>
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

export default DataManagement;
