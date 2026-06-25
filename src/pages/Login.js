import React, { useState } from 'react';
import {
  Container,
  Paper,
  Typography,
  TextField,
  Button,
  Box,
  Alert,
  Link,
  Grid,
} from '@mui/material';
import { useAuth } from '../context/AuthContext';

function Login() {
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    // Simulate API call delay
    setTimeout(() => {
      const result = login(username, password);
      
      if (!result.success) {
        setError(result.message);
      }
      
      setLoading(false);
    }, 500);
  };

  return (
    <Container component="main" maxWidth="xs">
      <Box
        sx={{
          marginTop: 8,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
        }}
      >
        <Paper
          elevation={3}
          sx={{
            padding: 4,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            width: '100%',
          }}
        >
          <Typography component="h1" variant="h4" gutterBottom>
            CarbonTrack Pro
          </Typography>
          <Typography variant="h6" color="textSecondary" gutterBottom>
            碳排放管理系统
          </Typography>
          
          <Box component="form" onSubmit={handleSubmit} sx={{ mt: 3, width: '100%' }}>
            {error && (
              <Alert severity="error" sx={{ mb: 2 }}>
                {error}
              </Alert>
            )}
            
            <TextField
              margin="normal"
              required
              fullWidth
              id="username"
              label="用户名"
              name="username"
              autoComplete="username"
              autoFocus
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
            <TextField
              margin="normal"
              required
              fullWidth
              name="password"
              label="密码"
              type="password"
              id="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            
            <Button
              type="submit"
              fullWidth
              variant="contained"
              sx={{ mt: 3, mb: 2 }}
              disabled={loading}
            >
              {loading ? '登录中...' : '登录'}
            </Button>
            
            <Grid container>
              <Grid item xs>
                <Link href="#" variant="body2">
                  忘记密码?
                </Link>
              </Grid>
              <Grid item>
                <Typography variant="body2" color="textSecondary">
                  演示账号: admin / 任意密码
                </Typography>
              </Grid>
            </Grid>
          </Box>
        </Paper>
        
        <Box mt={4} textAlign="center">
          <Typography variant="body2" color="textSecondary">
            © 2024 CarbonTrack Pro. All rights reserved.
          </Typography>
          <Typography variant="caption" color="textSecondary" display="block" mt={1}>
            版本 1.0.0 | 遵循 ISO 14064, GB/T 32150 标准
          </Typography>
        </Box>
      </Box>
    </Container>
  );
}

export default Login;
