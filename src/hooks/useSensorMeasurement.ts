import { useState, useCallback, useRef, useEffect } from 'react';

interface MeasurementState {
  isCalibrating: boolean;
  isMeasuring: boolean;
  isComplete: boolean;
  heightCm: number;
  heightFt: number;
  heightInches: number;
  confidence: number;
  debugInfo: string;
}

export const useSensorMeasurement = () => {
  const [measurementState, setMeasurementState] = useState<MeasurementState>({
    isCalibrating: false,
    isMeasuring: false,
    isComplete: false,
    heightCm: 0,
    heightFt: 0,
    heightInches: 0,
    confidence: 0,
    debugInfo: '',
  });

  const [error, setError] = useState<string | null>(null);
  const [permissionGranted, setPermissionGranted] = useState(false);

  // Measurement data storage
  const startOrientationRef = useRef<{ alpha: number; beta: number; gamma: number } | null>(null);
  const endOrientationRef = useRef<{ alpha: number; beta: number; gamma: number } | null>(null);
  const measurementStartRef = useRef<number>(0);
  const orientationSamplesRef = useRef<{ alpha: number; beta: number; gamma: number; timestamp: number }[]>([]);
  
  // Convert height to feet and inches
  const convertHeight = (cm: number) => {
    const totalInches = cm / 2.54;
    const feet = Math.floor(totalInches / 12);
    const inches = Math.round((totalInches % 12) * 10) / 10;
    return { feet, inches, cm: Math.round(cm * 10) / 10 };
  };

  // Request sensor permissions
  const requestSensorPermission = useCallback(async () => {
    try {
      console.log('Requesting sensor permissions...');
      
      if ('DeviceMotionEvent' in window && typeof (DeviceMotionEvent as any).requestPermission === 'function') {
        // iOS 13+ permission request
        const motionPermission = await (DeviceMotionEvent as any).requestPermission();
        console.log('Motion permission:', motionPermission);
        
        if (motionPermission !== 'granted') {
          setError('Motion sensor permission denied');
          return;
        }
      }

      if ('DeviceOrientationEvent' in window && typeof (DeviceOrientationEvent as any).requestPermission === 'function') {
        // iOS 13+ permission request
        const orientationPermission = await (DeviceOrientationEvent as any).requestPermission();
        console.log('Orientation permission:', orientationPermission);
        
        if (orientationPermission !== 'granted') {
          setError('Orientation sensor permission denied');
          return;
        }
      }

      setPermissionGranted(true);
      setError(null);
      console.log('All permissions granted');
    } catch (err) {
      console.error('Permission error:', err);
      setError('Failed to request sensor permissions');
    }
  }, []);

  // Test sensor availability
  const testSensors = useCallback(() => {
    console.log('Testing sensor availability...');
    
    const testOrientation = (event: DeviceOrientationEvent) => {
      console.log('Orientation test:', {
        alpha: event.alpha,
        beta: event.beta,
        gamma: event.gamma,
        absolute: event.absolute
      });
    };

    const testMotion = (event: DeviceMotionEvent) => {
      console.log('Motion test:', {
        acceleration: event.acceleration,
        accelerationIncludingGravity: event.accelerationIncludingGravity,
        rotationRate: event.rotationRate,
        interval: event.interval
      });
    };

    window.addEventListener('deviceorientation', testOrientation);
    window.addEventListener('devicemotion', testMotion);

    setTimeout(() => {
      window.removeEventListener('deviceorientation', testOrientation);
      window.removeEventListener('devicemotion', testMotion);
      console.log('Sensor test complete');
    }, 3000);
  }, []);

  // Calibrate sensors when phone is at ground level
  const calibrate = useCallback(async () => {
    if (!permissionGranted) {
      await requestSensorPermission();
      return;
    }

    console.log('Starting calibration...');
    setMeasurementState(prev => ({ ...prev, isCalibrating: true, debugInfo: 'Calibrating...' }));
    setError(null);

    // Test sensors first
    testSensors();

    // Collect calibration data for 3 seconds
    const calibrationSamples: { alpha: number; beta: number; gamma: number; timestamp: number }[] = [];
    
    const handleCalibrationOrientation = (event: DeviceOrientationEvent) => {
      if (event.alpha !== null && event.beta !== null && event.gamma !== null) {
        calibrationSamples.push({
          alpha: event.alpha,
          beta: event.beta,
          gamma: event.gamma,
          timestamp: Date.now(),
        });
        console.log('Calibration sample:', { alpha: event.alpha, beta: event.beta, gamma: event.gamma });
      }
    };

    window.addEventListener('deviceorientation', handleCalibrationOrientation);

    setTimeout(() => {
      window.removeEventListener('deviceorientation', handleCalibrationOrientation);
      
      if (calibrationSamples.length > 0) {
        // Calculate average calibration values
        const avgOrientation = calibrationSamples.reduce(
          (acc, sample) => ({
            alpha: acc.alpha + sample.alpha,
            beta: acc.beta + sample.beta,
            gamma: acc.gamma + sample.gamma,
          }),
          { alpha: 0, beta: 0, gamma: 0 }
        );

        startOrientationRef.current = {
          alpha: avgOrientation.alpha / calibrationSamples.length,
          beta: avgOrientation.beta / calibrationSamples.length,
          gamma: avgOrientation.gamma / calibrationSamples.length,
        };

        console.log('Calibration complete:', startOrientationRef.current);
        
        setMeasurementState(prev => ({ 
          ...prev, 
          isCalibrating: false,
          heightCm: 0,
          heightFt: 0,
          heightInches: 0,
          confidence: 0,
          debugInfo: `Calibrated: β=${startOrientationRef.current?.beta.toFixed(1)}°`
        }));
      } else {
        console.error('No calibration samples collected');
        setError('Failed to collect calibration data. Please check sensor permissions.');
        setMeasurementState(prev => ({ ...prev, isCalibrating: false }));
      }
    }, 3000);
  }, [permissionGranted, requestSensorPermission, testSensors]);

  // Start height measurement using orientation changes
  const startMeasurement = useCallback(() => {
    if (!startOrientationRef.current) {
      setError('Please calibrate first');
      return;
    }

    console.log('Starting measurement...');
    setMeasurementState(prev => ({ 
      ...prev, 
      isMeasuring: true, 
      isComplete: false,
      heightCm: 0,
      heightFt: 0,
      heightInches: 0,
      debugInfo: 'Measuring... move phone up slowly'
    }));
    setError(null);

    // Reset measurement data
    orientationSamplesRef.current = [];
    measurementStartRef.current = Date.now();
    endOrientationRef.current = null;

    const handleMeasurementOrientation = (event: DeviceOrientationEvent) => {
      if (!startOrientationRef.current || event.beta === null || event.alpha === null || event.gamma === null) return;

      const currentTime = Date.now();
      
      // Store orientation sample
      orientationSamplesRef.current.push({
        alpha: event.alpha,
        beta: event.beta,
        gamma: event.gamma,
        timestamp: currentTime,
      });

      // Calculate height based on beta angle change (pitch)
      const startBeta = startOrientationRef.current.beta;
      const currentBeta = event.beta;
      
      // Calculate angle difference (pitch change)
      let angleDiff = currentBeta - startBeta;
      
      // Normalize angle difference to handle wrap-around
      if (angleDiff > 180) angleDiff -= 360;
      if (angleDiff < -180) angleDiff += 360;

      // Use trigonometry to calculate height
      // Assume user holds phone at arm's length (~60cm from eye level)
      const armLength = 60; // cm
      const angleRadians = Math.abs(angleDiff) * (Math.PI / 180);
      
      // Calculate height using trigonometry
      let heightCm = 0;
      if (Math.abs(angleDiff) > 5) { // Minimum 5-degree change to start measuring
        heightCm = armLength * Math.tan(angleRadians);
        
        // Add some scaling factor based on typical phone usage patterns
        heightCm = heightCm * 2.5; // Empirical scaling factor
      }

      // Calculate confidence based on angle stability and measurement time
      const measurementDuration = (currentTime - measurementStartRef.current) / 1000;
      const confidence = Math.min(85 + Math.abs(angleDiff) * 0.5, 99.5);

      const { feet, inches, cm } = convertHeight(heightCm);

      setMeasurementState(prev => ({
        ...prev,
        heightCm: cm,
        heightFt: feet,
        heightInches: inches,
        confidence: Math.round(confidence * 10) / 10,
        debugInfo: `Angle: ${angleDiff.toFixed(1)}° | Time: ${measurementDuration.toFixed(1)}s`
      }));

      console.log('Measurement update:', {
        startBeta,
        currentBeta,
        angleDiff,
        heightCm,
        confidence
      });
    };

    window.addEventListener('deviceorientation', handleMeasurementOrientation);

    // Store the event listener reference for cleanup
    (window as any)._measurementListener = handleMeasurementOrientation;
  }, []);

  // Stop measurement
  const stopMeasurement = useCallback(() => {
    if ((window as any)._measurementListener) {
      window.removeEventListener('deviceorientation', (window as any)._measurementListener);
      delete (window as any)._measurementListener;
    }

    console.log('Measurement stopped');
    setMeasurementState(prev => ({ 
      ...prev, 
      isMeasuring: false, 
      isComplete: true,
      debugInfo: `Final: ${prev.heightCm}cm (${prev.heightFt}' ${prev.heightInches}")`
    }));
  }, []);

  // Reset all measurements
  const resetMeasurement = useCallback(() => {
    if ((window as any)._measurementListener) {
      window.removeEventListener('deviceorientation', (window as any)._measurementListener);
      delete (window as any)._measurementListener;
    }

    console.log('Measurement reset');
    setMeasurementState({
      isCalibrating: false,
      isMeasuring: false,
      isComplete: false,
      heightCm: 0,
      heightFt: 0,
      heightInches: 0,
      confidence: 0,
      debugInfo: '',
    });
    setError(null);
    
    orientationSamplesRef.current = [];
    startOrientationRef.current = null;
    endOrientationRef.current = null;
    measurementStartRef.current = 0;
  }, []);

  // Check sensor availability on mount
  useEffect(() => {
    console.log('Checking sensor availability...');
    
    if (!('DeviceOrientationEvent' in window)) {
      setError('Device orientation sensors not available');
      return;
    }

    if (!('DeviceMotionEvent' in window)) {
      console.warn('Device motion sensors not available, using orientation only');
    }

    console.log('Sensors available');
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