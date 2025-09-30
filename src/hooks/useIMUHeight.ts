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

  // IMU runtime refs
  const gravityRef = useRef<Vec3>({ x: 0, y: 0, z: 9.81 }); // m/s^2 (downwards)
  const lastTimestampRef = useRef<number>(0);
  const velocityRef = useRef<number>(0); // cm/s (vertical, up positive)
  const displacementRef = useRef<number>(0); // cm (integrated, may fluctuate)
  const peakDisplacementRef = useRef<number>(0); // cm (maximum reached - reported height)
  const stationarySamplesRef = useRef<number>(0);
  const totalSamplesRef = useRef<number>(0);
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
    displacementRef.current = 0;
    peakDisplacementRef.current = 0;
    velocityRef.current = 0;
    lastTimestampRef.current = 0;
    stationarySamplesRef.current = 0;
    totalSamplesRef.current = 0;

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

    // LPF coefficient for gravity (smaller = slower updates, more stable)
    const lpf = 0.01;

    const onMotion = (e: DeviceMotionEvent) => {
      const ag = e.accelerationIncludingGravity;
      const rr = e.rotationRate;
      const tsNow = performance.now();
      let dt = (typeof e.interval === 'number' && e.interval > 0)
        ? e.interval / 1000
        : (lastTimestampRef.current ? (tsNow - lastTimestampRef.current) / 1000 : 0.02);
      lastTimestampRef.current = tsNow;
      if (!ag) return;
      dt = Math.max(0.005, Math.min(0.05, dt));

      // Update gravity estimate via LPF, but freeze during motion to avoid contamination
      const gPrev = gravityRef.current;
      const gMeas: Vec3 = { x: ag.x ?? 0, y: ag.y ?? 0, z: ag.z ?? 0 };
      const gCandidate = vecAdd(vecScale(gPrev, 1 - lpf), vecScale(gMeas, lpf));
      const aLinCandidate = vecSub(gMeas, gCandidate);
      const rotMag = rr ? Math.sqrt((rr.alpha ?? 0) ** 2 + (rr.beta ?? 0) ** 2 + (rr.gamma ?? 0) ** 2) : 0;
      const aLinMagCandidate = vecLen(aLinCandidate);
      const allowGUpdate = aLinMagCandidate < 0.2 && rotMag < 3; // update only when mostly still
      const gNew = allowGUpdate ? gCandidate : gPrev;
      gravityRef.current = gNew;

      // Linear acceleration (device) in m/s^2 using stable gravity
      const aLin = vecSub(gMeas, gNew);

      // Up direction is opposite to gravity
      const up = vecNorm({ x: -gNew.x, y: -gNew.y, z: -gNew.z });

      // Vertical acceleration (upwards, m/s^2)
      const aVert = vecDot(aLin, up);

      // Convert to cm/s^2
      const aVertCm = aVert * 100;

      // Simple drift control + ZUPT
      const aLinMag = vecLen(aLin);

      const stationary = Math.abs(aVert) < 0.03 && rotMag < 0.7 && aLinMag < 0.06; // stricter + duration gate
      if (stationary) {
        stationarySamplesRef.current += 1;
      } else {
        stationarySamplesRef.current = 0;
      }

      // integrate velocity and displacement
      velocityRef.current += aVertCm * dt; // cm/s

      // apply very light damping only when moving
      if (!stationary) {
        velocityRef.current *= 0.9995;
      }

      // Zero velocity update if stationary for ~500ms
      if (stationarySamplesRef.current * dt >= 0.5) {
        velocityRef.current = 0;
      }

      // Only integrate upwards movement and track peak height reached
      const vUp = Math.max(0, velocityRef.current);
      displacementRef.current += vUp * dt; // cm
      if (displacementRef.current < 0) displacementRef.current = 0;
      peakDisplacementRef.current = Math.max(peakDisplacementRef.current, displacementRef.current);

      // Clamp to realistic human range
      if (displacementRef.current > 300) displacementRef.current = 300;
      if (peakDisplacementRef.current > 300) peakDisplacementRef.current = 300;

      totalSamplesRef.current += 1;

      const cm = Math.round(peakDisplacementRef.current * 10) / 10;
      const { feet, inches, cm: cmRounded } = toFeetInches(cm);

      // Confidence heuristic: more movement + stability at end
      const confBase = Math.min(95, 60 + Math.min(35, (cmRounded / 200) * 35));
      const conf = stationary ? Math.min(99.5, confBase + 3) : confBase;

      setMeasurementState((p) => ({
        ...p,
        heightCm: cmRounded,
        heightFt: feet,
        heightInches: inches,
        confidence: Math.round(conf * 10) / 10,
        debugInfo: `aV:${aVert.toFixed(2)} m/s² v:${velocityRef.current.toFixed(1)} cm/s dt:${dt.toFixed(3)}s`,
      }));
    };

    const onOrientation = (e: DeviceOrientationEvent) => {
      // If the phone is clearly tilting side-to-side, ignore; we only use IMU vertical
      // But we still keep this listener to ensure iOS permissions are active
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
    lastTimestampRef.current = 0;
    velocityRef.current = 0;
    displacementRef.current = 0;
    peakDisplacementRef.current = 0;
    stationarySamplesRef.current = 0;
    totalSamplesRef.current = 0;
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
