import React, { createContext, useContext, useState, useEffect } from 'react';

const AuthContext = createContext();

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  useEffect(() => {
    // Check for stored auth
    const storedUser = localStorage.getItem('carbonTrackUser');
    if (storedUser) {
      setUser(JSON.parse(storedUser));
      setIsAuthenticated(true);
    }
  }, []);

  const login = (username, password) => {
    // Mock authentication - in production, this would call an API
    if (username && password) {
      const userData = {
        id: 1,
        username,
        name: username === 'admin' ? '系统管理员' : '普通用户',
        role: username === 'admin' ? 'admin' : 'user',
        permissions: username === 'admin' 
          ? ['all'] 
          : ['view', 'edit_own'],
      };
      setUser(userData);
      setIsAuthenticated(true);
      localStorage.setItem('carbonTrackUser', JSON.stringify(userData));
      return { success: true };
    }
    return { success: false, message: '用户名或密码错误' };
  };

  const logout = () => {
    setUser(null);
    setIsAuthenticated(false);
    localStorage.removeItem('carbonTrackUser');
  };

  return (
    <AuthContext.Provider value={{ user, isAuthenticated, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
