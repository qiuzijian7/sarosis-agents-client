import React, { createContext, useContext, useState, useEffect } from 'react';

const EmissionContext = createContext();

// Emission factors database (simplified for demo)
const EMISSION_FACTORS = {
  electricity: {
    name: '外购电力',
    factor: 0.5703, // kg CO2/kWh
    unit: 'kWh',
    source: 'GB/T 32150-2015',
    category: 'scope2',
  },
  natural_gas: {
    name: '天然气',
    factor: 1.962, // kg CO2/m³
    unit: 'm³',
    source: 'GB/T 32150-2015',
    category: 'scope1',
  },
  gasoline: {
    name: '汽油',
    factor: 2.925, // kg CO2/L
    unit: 'L',
    source: 'GB/T 32150-2015',
    category: 'scope1',
  },
  diesel: {
    name: '柴油',
    factor: 3.096, // kg CO2/L
    unit: 'L',
    source: 'GB/T 32150-2015',
    category: 'scope1',
  },
  coal: {
    name: '煤炭',
    factor: 1.900, // kg CO2/kg
    unit: 'kg',
    source: 'GB/T 32150-2015',
    category: 'scope1',
  },
  business_travel: {
    name: '商务差旅',
    factor: 0.277, // kg CO2/passenger-km (air travel average)
    unit: 'km',
    source: 'IPCC 2006',
    category: 'scope3',
  },
  waste: {
    name: '废弃物处理',
    factor: 0.608, // kg CO2/kg (landfill)
    unit: 'kg',
    source: 'IPCC 2006',
    category: 'scope3',
  },
};

export function EmissionProvider({ children }) {
  const [emissionData, setEmissionData] = useState([]);
  const [activityRecords, setActivityRecords] = useState([]);

  useEffect(() => {
    // Load stored data
    const storedEmissions = localStorage.getItem('carbonTrackEmissions');
    const storedActivities = localStorage.getItem('carbonTrackActivities');
    
    if (storedEmissions) {
      setEmissionData(JSON.parse(storedEmissions));
    } else {
      // Initialize with sample data
      const sampleData = generateSampleData();
      setEmissionData(sampleData);
      localStorage.setItem('carbonTrackEmissions', JSON.stringify(sampleData));
    }
    
    if (storedActivities) {
      setActivityRecords(JSON.parse(storedActivities));
    }
  }, []);

  const generateSampleData = () => {
    const currentYear = new Date().getFullYear();
    const data = [];
    
    for (let month = 1; month <= 12; month++) {
      data.push({
        id: `sample-${month}`,
        date: `${currentYear}-${month.toString().padStart(2, '0')}-01`,
        category: 'scope2',
        activityType: 'electricity',
        activityAmount: Math.random() * 10000 + 5000,
        emissionFactor: EMISSION_FACTORS.electricity.factor,
        emissionAmount: 0, // Will be calculated
        unit: EMISSION_FACTORS.electricity.unit,
        department: ['生产部', '行政部', '研发部'][Math.floor(Math.random() * 3)],
        notes: '示例数据',
        createdAt: new Date().toISOString(),
      });
    }
    
    // Calculate emissions
    data.forEach(record => {
      record.emissionAmount = record.activityAmount * record.emissionFactor;
    });
    
    return data;
  };

  const addEmissionRecord = (record) => {
    const newRecord = {
      ...record,
      id: `emission-${Date.now()}`,
      emissionAmount: record.activityAmount * getEmissionFactor(record.activityType),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    
    const updatedData = [...emissionData, newRecord];
    setEmissionData(updatedData);
    localStorage.setItem('carbonTrackEmissions', JSON.stringify(updatedData));
    
    return newRecord;
  };

  const updateEmissionRecord = (id, updates) => {
    const updatedData = emissionData.map(record => {
      if (record.id === id) {
        const updated = {
          ...record,
          ...updates,
          updatedAt: new Date().toISOString(),
        };
        if (updates.activityAmount || updates.activityType) {
          updated.emissionAmount = updated.activityAmount * getEmissionFactor(updated.activityType);
        }
        return updated;
      }
      return record;
    });
    
    setEmissionData(updatedData);
    localStorage.setItem('carbonTrackEmissions', JSON.stringify(updatedData));
  };

  const deleteEmissionRecord = (id) => {
    const updatedData = emissionData.filter(record => record.id !== id);
    setEmissionData(updatedData);
    localStorage.setItem('carbonTrackEmissions', JSON.stringify(updatedData));
  };

  const getEmissionFactor = (activityType) => {
    return EMISSION_FACTORS[activityType]?.factor || 0;
  };

  const getMonthlyEmissions = (year, month) => {
    return emissionData.filter(record => {
      const recordDate = new Date(record.date);
      return recordDate.getFullYear() === year && 
             recordDate.getMonth() === month - 1;
    });
  };

  const getYearlyEmissions = (year) => {
    return emissionData.filter(record => {
      const recordDate = new Date(record.date);
      return recordDate.getFullYear() === year;
    });
  };

  const getTotalEmissions = (year) => {
    const yearData = getYearlyEmissions(year);
    return yearData.reduce((sum, record) => sum + record.emissionAmount, 0);
  };

  return (
    <EmissionContext.Provider value={{
      emissionData,
      activityRecords,
      emissionFactors: EMISSION_FACTORS,
      addEmissionRecord,
      updateEmissionRecord,
      deleteEmissionRecord,
      getMonthlyEmissions,
      getYearlyEmissions,
      getTotalEmissions,
    }}>
      {children}
    </EmissionContext.Provider>
  );
}

export function useEmission() {
  const context = useContext(EmissionContext);
  if (!context) {
    throw new Error('useEmission must be used within an EmissionProvider');
  }
  return context;
}
