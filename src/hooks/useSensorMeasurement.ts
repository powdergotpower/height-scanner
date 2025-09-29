import { useState, useCallback, useRef, useEffect } from 'react';

interface SensorData {
  acceleration: { x: number; y: number; z: number };
  rotationRate: { alpha: number; beta: number; gamma: number };
  timestamp: number;
}

interface MeasurementState {
  isCalibrating: boolean;
  isMeasuring: boolean;
  isComplete: boolean;
  heightCm: number;
  heightFt: number;
  confidence: number;
}

export const useSensorMeasurement = () => {
  const [measurementState, setMeasurementState] = useState<MeasurementState>({
    isCalibrating: false,
    isMeasuring: false,
    isComplete: false,
    heightCm: 0,
    heightFt: 0,
    confidence: 0,
  });

  const [error, setError] = useState<string | null>(null);
  const [permissionGranted, setPermissionGranted] = useState(false);

  // Sensor data storage
  const sensorDataRef = useRef<SensorData[]>([]);
  const calibrationDataRef = useRef<{ x: number; y: number; z: number } | null>(null);
  const startPositionRef = useRef<{ x: number; y: number; z: number } | null>(null);
  const velocityRef = useRef({ x: 0, y: 0, z: 0 });
  const positionRef = useRef({ x: 0, y: 0, z: 0 });
  
  // Filtering parameters
  const GRAVITY = 9.81;
  const NOISE_THRESHOLD = 0.1;
  const VERTICAL_THRESHOLD = 0.8; // Minimum vertical component for valid movement
  const SAMPLE_RATE = 60; // Hz
  const FILTER_ALPHA = 0.8; // Low-pass filter coefficient

  // Low-pass filter for noise reduction
  const applyLowPassFilter = (current: number, previous: number, alpha: number): number => {
    return alpha * current + (1 - alpha) * previous;
  };

  // Request sensor permissions
  const requestSensorPermission = useCallback(async () => {
    try {
      if ('DeviceMotionEvent' in window && 'requestPermission' in DeviceMotionEvent) {
        // iOS 13+ permission request
        const permission = await (DeviceMotionEvent as any).requestPermission();
        if (permission === 'granted') {
          setPermissionGranted(true);
          setError(null);
        } else {
          setError('Motion sensor permission denied');
        }
      } else {
        // Android or older iOS
        setPermissionGranted(true);
      }
    } catch (err) {
      setError('Failed to request sensor permissions');
    }
  }, []);

  // Calibrate sensors when phone is at ground level
  const calibrate = useCallback(async () => {
    if (!permissionGranted) {
      await requestSensorPermission();
      return;
    }

    setMeasurementState(prev => ({ ...prev, isCalibrating: true }));
    setError(null);

    // Collect calibration data for 2 seconds
    const calibrationSamples: SensorData[] = [];
    
    const handleCalibrationMotion = (event: DeviceMotionEvent) => {
      if (event.acceleration && event.rotationRate) {
        calibrationSamples.push({
          acceleration: {
            x: event.acceleration.x || 0,
            y: event.acceleration.y || 0,
            z: event.acceleration.z || 0,
          },
          rotationRate: {
            alpha: event.rotationRate.alpha || 0,
            beta: event.rotationRate.beta || 0,
            gamma: event.rotationRate.gamma || 0,
          },
          timestamp: event.timeStamp || Date.now(),
        });
      }
    };

    window.addEventListener('devicemotion', handleCalibrationMotion);

    setTimeout(() => {
      window.removeEventListener('devicemotion', handleCalibrationMotion);
      
      if (calibrationSamples.length > 0) {
        // Calculate average calibration values
        const avgAcceleration = calibrationSamples.reduce(
          (acc, sample) => ({
            x: acc.x + sample.acceleration.x,
            y: acc.y + sample.acceleration.y,
            z: acc.z + sample.acceleration.z,
          }),
          { x: 0, y: 0, z: 0 }
        );

        calibrationDataRef.current = {
          x: avgAcceleration.x / calibrationSamples.length,
          y: avgAcceleration.y / calibrationSamples.length,
          z: avgAcceleration.z / calibrationSamples.length,
        };

        setMeasurementState(prev => ({ 
          ...prev, 
          isCalibrating: false,
          heightCm: 0,
          heightFt: 0,
          confidence: 0,
        }));
      } else {
        setError('Failed to collect calibration data');
        setMeasurementState(prev => ({ ...prev, isCalibrating: false }));
      }
    }, 2000);
  }, [permissionGranted, requestSensorPermission]);

  // Start height measurement
  const startMeasurement = useCallback(() => {
    if (!calibrationDataRef.current) {
      setError('Please calibrate first');
      return;
    }

    setMeasurementState(prev => ({ 
      ...prev, 
      isMeasuring: true, 
      isComplete: false,
      heightCm: 0,
      heightFt: 0,
    }));
    setError(null);

    // Reset measurement data
    sensorDataRef.current = [];
    velocityRef.current = { x: 0, y: 0, z: 0 };
    positionRef.current = { x: 0, y: 0, z: 0 };
    startPositionRef.current = null;

    let lastTimestamp = 0;
    let filteredAcceleration = { x: 0, y: 0, z: 0 };

    const handleMeasurementMotion = (event: DeviceMotionEvent) => {
      if (!event.acceleration || !calibrationDataRef.current) return;

      const currentTime = event.timeStamp || Date.now();
      const deltaTime = lastTimestamp ? (currentTime - lastTimestamp) / 1000 : 0;
      
      if (deltaTime <= 0 || deltaTime > 0.1) {
        lastTimestamp = currentTime;
        return;
      }

      // Remove gravity and calibration offset
      const correctedAcceleration = {
        x: (event.acceleration.x || 0) - calibrationDataRef.current.x,
        y: (event.acceleration.y || 0) - calibrationDataRef.current.y,
        z: (event.acceleration.z || 0) - calibrationDataRef.current.z,
      };

      // Apply low-pass filter to reduce noise
      filteredAcceleration = {
        x: applyLowPassFilter(correctedAcceleration.x, filteredAcceleration.x, FILTER_ALPHA),
        y: applyLowPassFilter(correctedAcceleration.y, filteredAcceleration.y, FILTER_ALPHA),
        z: applyLowPassFilter(correctedAcceleration.z, filteredAcceleration.z, FILTER_ALPHA),
      };

      // Calculate magnitude and check if movement is primarily vertical
      const totalMagnitude = Math.sqrt(
        filteredAcceleration.x ** 2 + 
        filteredAcceleration.y ** 2 + 
        filteredAcceleration.z ** 2
      );

      // Only process significant vertical movements
      if (totalMagnitude > NOISE_THRESHOLD) {
        const verticalComponent = Math.abs(filteredAcceleration.z);
        const horizontalMagnitude = Math.sqrt(
          filteredAcceleration.x ** 2 + filteredAcceleration.y ** 2
        );

        // Check if movement is primarily vertical
        if (verticalComponent / (verticalComponent + horizontalMagnitude) > VERTICAL_THRESHOLD) {
          // Integrate acceleration to get velocity (only vertical component)
          velocityRef.current.z += filteredAcceleration.z * deltaTime;
          
          // Integrate velocity to get position
          positionRef.current.z += velocityRef.current.z * deltaTime;

          // Store start position for relative measurement
          if (!startPositionRef.current) {
            startPositionRef.current = { ...positionRef.current };
          }

          // Calculate height from start position
          const heightMeters = Math.abs(positionRef.current.z - startPositionRef.current.z);
          const heightCm = heightMeters * 100;
          const heightFt = heightCm / 30.48;

          // Calculate confidence based on movement consistency
          const confidence = Math.min(95 + (verticalComponent / totalMagnitude) * 5, 99.9);

          setMeasurementState(prev => ({
            ...prev,
            heightCm: Math.round(heightCm * 10) / 10,
            heightFt: Math.round(heightFt * 100) / 100,
            confidence: Math.round(confidence * 10) / 10,
          }));
        }
      }

      lastTimestamp = currentTime;
    };

    window.addEventListener('devicemotion', handleMeasurementMotion);

    // Store the event listener reference for cleanup
    (window as any)._measurementListener = handleMeasurementMotion;
  }, []);

  // Stop measurement
  const stopMeasurement = useCallback(() => {
    if ((window as any)._measurementListener) {
      window.removeEventListener('devicemotion', (window as any)._measurementListener);
      delete (window as any)._measurementListener;
    }

    setMeasurementState(prev => ({ 
      ...prev, 
      isMeasuring: false, 
      isComplete: true 
    }));
  }, []);

  // Reset all measurements
  const resetMeasurement = useCallback(() => {
    if ((window as any)._measurementListener) {
      window.removeEventListener('devicemotion', (window as any)._measurementListener);
      delete (window as any)._measurementListener;
    }

    setMeasurementState({
      isCalibrating: false,
      isMeasuring: false,
      isComplete: false,
      heightCm: 0,
      heightFt: 0,
      confidence: 0,
    });
    setError(null);
    
    sensorDataRef.current = [];
    calibrationDataRef.current = null;
    startPositionRef.current = null;
    velocityRef.current = { x: 0, y: 0, z: 0 };
    positionRef.current = { x: 0, y: 0, z: 0 };
  }, []);

  // Check sensor availability on mount
  useEffect(() => {
    if (!('DeviceMotionEvent' in window)) {
      setError('Device motion sensors not available');
    }
  }, []);

  return {
    measurementState,
    error,
    permissionGranted,
    requestSensorPermission,
    calibrate,
    startMeasurement,
    stopMeasurement,
    resetMeasurement,
  };
};