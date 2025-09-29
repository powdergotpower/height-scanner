import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useIMUHeight } from '@/hooks/useIMUHeight';
import { Ruler, Smartphone, RotateCcw, PlayCircle, StopCircle } from 'lucide-react';

const HeightMeasurement = () => {
  const {
    measurementState,
    error,
    permissionGranted,
    requestSensorPermission,
    calibrate,
    startMeasurement,
    stopMeasurement,
    resetMeasurement,
  } = useIMUHeight();

  const [showInstructions, setShowInstructions] = useState(true);

  const formatHeight = (cm: number, ft: number, inches: number) => {
    return {
      metric: `${cm} cm`,
      imperial: `${ft}' ${inches}"`,
      combined: `${cm} cm (${ft}' ${inches}")`
    };
  };

  if (showInstructions && !permissionGranted) {
    return (
      <div className="min-h-screen bg-measurement-gradient flex items-center justify-center p-4">
        <Card className="max-w-md w-full p-8 text-center shadow-elevation">
          <div className="mb-6">
            <Ruler className="h-16 w-16 mx-auto text-precision mb-4" />
            <h1 className="text-2xl font-bold mb-2">Height Measurement</h1>
            <p className="text-muted-foreground">
              Precise height measurement using device sensors
            </p>
          </div>
          
          <div className="space-y-4 mb-6">
            <div className="flex items-start space-x-3 text-left">
              <div className="w-6 h-6 rounded-full bg-precision text-white flex items-center justify-center text-sm font-mono">1</div>
              <p className="text-sm">Place your phone flat on the ground</p>
            </div>
            <div className="flex items-start space-x-3 text-left">
              <div className="w-6 h-6 rounded-full bg-precision text-white flex items-center justify-center text-sm font-mono">2</div>
              <p className="text-sm">Calibrate to establish baseline</p>
            </div>
            <div className="flex items-start space-x-3 text-left">
              <div className="w-6 h-6 rounded-full bg-precision text-white flex items-center justify-center text-sm font-mono">3</div>
              <p className="text-sm">Move phone straight up to your head</p>
            </div>
          </div>

          <Button 
            onClick={() => {
              requestSensorPermission();
              setShowInstructions(false);
            }}
            className="w-full bg-primary-gradient hover:shadow-precise transition-all duration-300"
            size="lg"
          >
            Enable Sensors & Start
          </Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-measurement-gradient flex flex-col items-center justify-center p-4">
      {error && (
        <Card className="mb-4 p-4 border-destructive bg-destructive/5 max-w-md w-full">
          <p className="text-destructive text-sm">{error}</p>
        </Card>
      )}

      <Card className="max-w-md w-full p-8 shadow-elevation">
        {/* Status Header */}
        <div className="text-center mb-8">
          <div className="relative mb-4">
            <Smartphone className={`h-12 w-12 mx-auto transition-all duration-500 ${
              measurementState.isMeasuring ? 'text-success animate-measurement-glow' : 
              measurementState.isCalibrating ? 'text-warning animate-pulse' :
              'text-precision'
            }`} />
            {measurementState.isMeasuring && (
              <div className="absolute inset-0 rounded-full border-2 border-success animate-pulse-ring" />
            )}
          </div>
          
          <h2 className="text-xl font-semibold mb-2">
            {measurementState.isCalibrating ? 'Calibrating...' :
             measurementState.isMeasuring ? 'Measuring...' :
             measurementState.isComplete ? 'Measurement Complete' :
             'Ready to Measure'}
          </h2>
          
          <p className="text-tech text-sm">
            {measurementState.isCalibrating ? 'Keep phone steady on ground' :
             measurementState.isMeasuring ? 'Move phone straight up' :
             measurementState.isComplete ? 'Height measurement finished' :
             'Place phone on ground and calibrate'}
          </p>
        </div>

        {/* Measurement Display */}
        {(measurementState.isMeasuring || measurementState.isComplete) && (
          <div className="mb-8 p-6 bg-precision-gradient rounded-lg text-white text-center">
            <div className="space-y-3">
              <div className="text-4xl font-mono font-bold">
                {measurementState.heightCm} cm
              </div>
              <div className="text-xl font-mono opacity-90">
                {measurementState.heightFt}' {measurementState.heightInches}"
              </div>
              <div className="text-sm opacity-80 border-t border-white/20 pt-2">
                Metric: {measurementState.heightCm} cm
              </div>
              <div className="text-sm opacity-80">
                Imperial: {measurementState.heightFt} feet {measurementState.heightInches} inches
              </div>
              <div className="text-sm opacity-75 border-t border-white/20 pt-2">
                Accuracy: {measurementState.confidence}%
              </div>
              {measurementState.debugInfo && (
                <div className="text-xs opacity-60 font-mono">
                  Debug: {measurementState.debugInfo}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Control Buttons */}
        <div className="space-y-3">
          {!measurementState.isCalibrating && !measurementState.isMeasuring && !measurementState.isComplete && (
            <Button
              onClick={calibrate}
              className="w-full bg-precision hover:bg-precision/90 transition-all duration-300"
              size="lg"
            >
              <Smartphone className="mr-2 h-4 w-4" />
              Calibrate at Ground Level
            </Button>
          )}

          {!measurementState.isCalibrating && !measurementState.isMeasuring && !measurementState.isComplete && (
            <Button
              onClick={startMeasurement}
              variant="outline"
              className="w-full"
              size="lg"
              disabled={!measurementState}
            >
              <PlayCircle className="mr-2 h-4 w-4" />
              Start Measurement
            </Button>
          )}

          {measurementState.isMeasuring && (
            <Button
              onClick={stopMeasurement}
              className="w-full bg-success hover:bg-success/90"
              size="lg"
            >
              <StopCircle className="mr-2 h-4 w-4" />
              Stop & Finish
            </Button>
          )}

          {measurementState.isComplete && (
            <Button
              onClick={resetMeasurement}
              variant="outline"
              className="w-full"
              size="lg"
            >
              <RotateCcw className="mr-2 h-4 w-4" />
              Measure Again
            </Button>
          )}
        </div>

        {/* Live Feedback */}
        {measurementState.isMeasuring && (
          <div className="mt-6 p-4 bg-muted rounded-lg">
            <div className="text-center">
              <div className="text-sm text-tech mb-2">Live Reading</div>
              <div className="font-mono text-lg">{measurementState.heightCm} cm</div>
              <div className="font-mono text-sm text-tech">{measurementState.heightFt}' {measurementState.heightInches}"</div>
              <div className="w-full bg-background rounded-full h-2 mt-3 overflow-hidden">
                <div 
                  className="h-full bg-precision-gradient transition-all duration-300"
                  style={{ width: `${Math.min((measurementState.heightCm / 200) * 100, 100)}%` }}
                />
              </div>
              {measurementState.debugInfo && (
                <div className="text-xs text-tech mt-2 font-mono">
                  {measurementState.debugInfo}
                </div>
              )}
            </div>
          </div>
        )}
      </Card>

      {/* Instructions Footer */}
      <div className="mt-6 max-w-md w-full">
        <Card className="p-4 bg-background/50 backdrop-blur-sm">
          <p className="text-xs text-tech text-center">
            Keep phone vertical during measurement. Move slowly and steadily for best accuracy.
          </p>
        </Card>
      </div>
    </div>
  );
};

export default HeightMeasurement;