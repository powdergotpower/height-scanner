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

interface Vec3 { x: number; y: number; z: number }

const toFeetInches = (cm: number) => {
  const totalInches = cm / 2.54;
  const feet = Math.floor(totalInches / 12);
  const inches = Math.round((totalInches % 12) * 10) / 10;
  return { feet, inches, cm: Math.round(cm * 10) / 10 };
};

const vecAdd = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const vecScale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
const vecLen = (a: Vec3): number => Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
const vecSub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const vecDot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const vecNorm = (a: Vec3): Vec3 => {
  const l = vecLen(a) || 1;
  return { x: a.x / l, y: a.y / l, z: a.z / l };
};

export const useIMUHeight = () => {
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

  // Simple conservative approach - track only upward segments
  const gravityRef = useRef<Vec3>({ x: 0, y: 0, z: 9.81 });
  const lastTimestampRef = useRef<number>(0);
  const totalHeightRef = useRef<number>(0); // accumulated height from upward segments
  const velocityRef = useRef<number>(0); // current velocity
  const stationaryTimeRef = useRef<number>(0);
  const movingUpTimeRef = useRef<number>(0);
  const hasCalibratedRef = useRef<boolean>(false);

  // permissions (iOS 13+)
  const requestSensorPermission = useCallback(async () => {
    try {
      if (
        'DeviceMotionEvent' in window &&
        typeof (DeviceMotionEvent as any).requestPermission === 'function'
      ) {
        const motionPermission = await (DeviceMotionEvent as any).requestPermission();
        if (motionPermission !== 'granted') {
          setError('Motion sensor permission denied');
          return;
        }
      }
      if (
        'DeviceOrientationEvent' in window &&
        typeof (DeviceOrientationEvent as any).requestPermission === 'function'
      ) {
        const orientationPermission = await (DeviceOrientationEvent as any).requestPermission();
        if (orientationPermission !== 'granted') {
          setError('Orientation sensor permission denied');
          return;
        }
      }
      setPermissionGranted(true);
      setError(null);
    } catch (e) {
      setError('Failed to request sensor permissions');
    }
  }, []);

  // Calibration: estimate gravity vector via low-pass while stationary
  const calibrate = useCallback(async () => {
    if (!permissionGranted) {
      await requestSensorPermission();
      if (!permissionGranted) return;
    }
    setError(null);
    setMeasurementState((p) => ({ ...p, isCalibrating: true, debugInfo: 'Calibrating…' }));

    const samples: Vec3[] = [];
    const handler = (e: DeviceMotionEvent) => {
      const ag = e.accelerationIncludingGravity;
      if (!ag) return;
      const v: Vec3 = { x: ag.x ?? 0, y: ag.y ?? 0, z: ag.z ?? 0 };
      samples.push(v);
    };

    window.addEventListener('devicemotion', handler);
    await new Promise((res) => setTimeout(res, 1500));
    window.removeEventListener('devicemotion', handler);

    if (samples.length === 0) {
      setError('No sensor data during calibration');
      setMeasurementState((p) => ({ ...p, isCalibrating: false }));
      return;
    }

    // average gravity
    const avg = samples.reduce((acc, s) => vecAdd(acc, s), { x: 0, y: 0, z: 0 });
    const g = vecScale(avg, 1 / samples.length);
    gravityRef.current = g;
    hasCalibratedRef.current = true;

    setMeasurementState((p) => ({
      ...p,
      isCalibrating: false,
      isMeasuring: false,
      isComplete: false,
      heightCm: 0,
      heightFt: 0,
      heightInches: 0,
      confidence: 0,
      debugInfo: `Calibrated | |g|=${vecLen(g).toFixed(2)} m/s²`,
    }));
  }, [permissionGranted, requestSensorPermission]);

  const startMeasurement = useCallback(() => {
    if (!hasCalibratedRef.current) {
      setError('Please calibrate first');
      return;
    }
    setError(null);
    
    // Reset everything
    totalHeightRef.current = 0;
    velocityRef.current = 0;
    lastTimestampRef.current = 0;
    stationaryTimeRef.current = 0;
    movingUpTimeRef.current = 0;

    setMeasurementState((p) => ({
      ...p,
      isMeasuring: true,
      isComplete: false,
      debugInfo: 'Measuring… move straight up',
      heightCm: 0,
      heightFt: 0,
      heightInches: 0,
      confidence: 0,
    }));

    const onMotion = (e: DeviceMotionEvent) => {
      const ag = e.accelerationIncludingGravity;
      const tsNow = performance.now();
      const dt = lastTimestampRef.current ? Math.min(0.05, (tsNow - lastTimestampRef.current) / 1000) : 0.02;
      lastTimestampRef.current = tsNow;
      if (!ag || dt <= 0) return;

      // Get sensor data
      const gMeas: Vec3 = { x: ag.x ?? 0, y: ag.y ?? 0, z: ag.z ?? 0 };
      const gravity = gravityRef.current;
      
      // Linear acceleration
      const aLin = vecSub(gMeas, gravity);
      const up = vecNorm({ x: -gravity.x, y: -gravity.y, z: -gravity.z });
      const aVert = vecDot(aLin, up); // m/s^2
      
      // Convert to cm/s^2
      const aVertCm = aVert * 100;
      
      // Very conservative motion detection
      const isStationary = Math.abs(aVert) < 0.02 && vecLen(aLin) < 0.05;
      const isMovingUp = aVert > 0.05;
      
      if (isStationary) {
        stationaryTimeRef.current += dt;
        movingUpTimeRef.current = 0;
        // Aggressive velocity reset when stationary
        if (stationaryTimeRef.current > 0.3) {
          velocityRef.current = 0;
        }
      } else if (isMovingUp) {
        stationaryTimeRef.current = 0;
        movingUpTimeRef.current += dt;
        // Only integrate when clearly moving up
        velocityRef.current += aVertCm * dt;
        // Strict velocity limits
        velocityRef.current = Math.max(0, Math.min(80, velocityRef.current)); // max 80 cm/s
      } else {
        stationaryTimeRef.current = 0;
        movingUpTimeRef.current = 0;
        // Apply strong damping when not clearly moving up
        velocityRef.current *= 0.9;
      }
      
      // Integrate displacement only when velocity is positive and reasonable
      if (velocityRef.current > 1 && movingUpTimeRef.current > 0.1) {
        totalHeightRef.current += velocityRef.current * dt;
      }
      
      // Clamp to reasonable range
      totalHeightRef.current = Math.max(0, Math.min(250, totalHeightRef.current));
      
      const cm = Math.round(totalHeightRef.current * 10) / 10;
      const { feet, inches, cm: cmRounded } = toFeetInches(cm);

      // Simple confidence based on stability
      const conf = isStationary && cm > 10 ? 95 : 75;

      setMeasurementState((p) => ({
        ...p,
        heightCm: cmRounded,
        heightFt: feet,
        heightInches: inches,
        confidence: conf,
        debugInfo: `aV:${aVert.toFixed(2)} v:${velocityRef.current.toFixed(1)} ${isStationary ? 'STILL' : isMovingUp ? 'UP' : 'OTHER'}`,
      }));
    };

    const onOrientation = (e: DeviceOrientationEvent) => {
      // Keep for iOS permissions
    };

    window.addEventListener('devicemotion', onMotion);
    window.addEventListener('deviceorientation', onOrientation);

    ;(window as any)._imu_onMotion = onMotion;
    ;(window as any)._imu_onOrientation = onOrientation;
  }, []);

  const stopMeasurement = useCallback(() => {
    if ((window as any)._imu_onMotion) {
      window.removeEventListener('devicemotion', (window as any)._imu_onMotion);
      delete (window as any)._imu_onMotion;
    }
    if ((window as any)._imu_onOrientation) {
      window.removeEventListener('deviceorientation', (window as any)._imu_onOrientation);
      delete (window as any)._imu_onOrientation;
    }

    setMeasurementState((p) => ({
      ...p,
      isMeasuring: false,
      isComplete: true,
      debugInfo: `Final: ${p.heightCm}cm (${p.heightFt}' ${p.heightInches}\")`,
    }));
  }, []);

  const resetMeasurement = useCallback(() => {
    if ((window as any)._imu_onMotion) {
      window.removeEventListener('devicemotion', (window as any)._imu_onMotion);
      delete (window as any)._imu_onMotion;
    }
    if ((window as any)._imu_onOrientation) {
      window.removeEventListener('deviceorientation', (window as any)._imu_onOrientation);
      delete (window as any)._imu_onOrientation;
    }

    gravityRef.current = { x: 0, y: 0, z: 9.81 };
    totalHeightRef.current = 0;
    velocityRef.current = 0;
    lastTimestampRef.current = 0;
    stationaryTimeRef.current = 0;
    movingUpTimeRef.current = 0;
    hasCalibratedRef.current = false;

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
  }, []);

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
