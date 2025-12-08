#include <Arduino.h>
#include <SPI.h>
#include <PacketSerial.h>
#include "FutabaNAGP1250.h"
#include "frame_generated.h"

FutabaNAGP1250 vfd(SPI, 5, 35); 

PacketSerial_<COBS, 0, 1024> packetSerial;

uint8_t currentFrame[560] = {0};

const uint8_t STATUS_OK          = 0xA5;
const uint8_t STATUS_ERR_VERIFY  = 0xE1;
const uint8_t STATUS_ERR_NODATA  = 0xE2;
const uint8_t STATUS_ERR_OTHER   = 0xE3;

// --- CRC32 Implementation ---
uint32_t crc32(const uint8_t* data, size_t length) {
    uint32_t crc = 0xFFFFFFFF;
    for (size_t i = 0; i < length; i++) {
        crc ^= data[i];
        for (uint8_t j = 0; j < 8; j++) {
            if (crc & 1) crc = (crc >> 1) ^ 0xEDB88320;
            else         crc >>= 1;
        }
    }
    return ~crc;
}

void sendStatus(uint8_t code) {
    Serial.write(code);
}

size_t unpackBits(const uint8_t* input, size_t inputLen, uint8_t* output, size_t maxOutputLen) {
    size_t i = 0; 
    size_t j = 0; 
    while (i < inputLen && j < maxOutputLen) {
        int8_t n = (int8_t)input[i++];
        if (n == -128) continue;
        if (n >= 0) {
            uint8_t count = n + 1;
            if (j + count > maxOutputLen || i + count > inputLen) break; 
            memcpy(&output[j], &input[i], count);
            i += count;
            j += count;
        } else {
            uint8_t count = 1 - n;
            if (j + count > maxOutputLen || i >= inputLen) break; 
            uint8_t val = input[i++];
            memset(&output[j], val, count);
            j += count;
        }
    }
    return j;
}

void onPacketReceived(const uint8_t* buffer, size_t size) {
    if (size == 0) return;

    flatbuffers::Verifier verifier(buffer, size);
    if (!Futaba::VerifyFrameBuffer(verifier)) {
        sendStatus(STATUS_ERR_VERIFY);
        return;
    }

    auto frame = Futaba::GetFrame(buffer);
    auto type = frame->type();
    auto dataVector = frame->data();
    uint32_t receivedCrc = frame->crc32();

    if (!dataVector) {
        sendStatus(STATUS_ERR_NODATA);
        return;
    }

    const uint8_t* dataPtr = dataVector->data();
    size_t dataLen = dataVector->size();

    // 2. Verify CRC32 Integrity of the Payload
    uint32_t calculatedCrc = crc32(dataPtr, dataLen);
    if (calculatedCrc != receivedCrc) {
        // Corrupted payload! Reject frame to prevent artifacts.
        sendStatus(STATUS_ERR_VERIFY);
        return; 
    }

    if (type == Futaba::FrameType_Full) {
        if (dataLen <= 560) {
            memcpy(currentFrame, dataPtr, dataLen);
        }
    } else if (type == Futaba::FrameType_Delta) {
        uint8_t deltaBuffer[560];
        size_t decodedLen = unpackBits(dataPtr, dataLen, deltaBuffer, 560);
        if (decodedLen == 560) {
            for (size_t i = 0; i < 560; i++) {
                currentFrame[i] ^= deltaBuffer[i];
            }
        }
    }

    std::vector<uint8_t> image(currentFrame, currentFrame + 560);
    vfd.displayGraphicImage(image, 140, 32);

    sendStatus(STATUS_OK);
}

void setup() {
    Serial.setRxBufferSize(2048); 
    Serial.begin(230400);
    
    packetSerial.setStream(&Serial);
    packetSerial.setPacketHandler(&onPacketReceived);

    SPI.begin(18, -1, 23, -1); 

    vfd.begin(FutabaNAGP1250::BASE_WINDOW_MODE_DEFAULT, 8, 0); 
    vfd.setCharacterCode(FutabaNAGP1250::CHAR_CODE_PC437);
    vfd.setWriteLogic(FutabaNAGP1250::WRITE_MODE_NORMAL);
    vfd.clearWindow(0);
    
    vfd.writeText("Stream Ready");
    delay(3000);
    vfd.clearWindow(0);
    
    sendStatus(STATUS_OK);
}

void loop() {
    packetSerial.update();
}
