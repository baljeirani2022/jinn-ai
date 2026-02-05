import React from 'react';

function QRCode({ qrCode, isConnected }) {
  if (isConnected) {
    return (
      <div className="qr-container connected">
        <div className="connected-icon">✓</div>
        <p>WhatsApp Connected</p>
      </div>
    );
  }

  return (
    <div className="qr-container">
      {qrCode ? (
        <>
          <img src={qrCode} alt="Scan QR Code" className="qr-image" />
          <p>Scan with WhatsApp to link your device</p>
          <p className="qr-instructions">
            Open WhatsApp → Settings → Linked Devices → Link a Device
          </p>
        </>
      ) : (
        <div className="loading">
          <div className="spinner"></div>
          <p>Waiting for QR code...</p>
        </div>
      )}
    </div>
  );
}

export default QRCode;
