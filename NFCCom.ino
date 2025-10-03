#include <Wire.h>
#include <Adafruit_PN532.h>
#include <Arduino.h>

#define PIN_MODE_BTN 7 
#define PIN_EXEC_BTN 8 


const unsigned long DEBOUNCE_MS = 35;
bool modeStable = HIGH, modeReading = HIGH;
bool execStable = HIGH, execReading = HIGH;
unsigned long modeChangedAt = 0, execChangedAt = 0;

enum Mode { MODE_READ, MODE_WRITE };
Mode currentMode = MODE_READ;
// === UNO 핀 매핑 ===
#define PN532_IRQ    2 
#define PN532_RESET  -1   

Adafruit_PN532 nfc(PN532_IRQ, PN532_RESET);


#define START_BLOCK  4
#define MAX_BLOCK    63

const char* MESSAGE = "ThisIsSampleText_1";

uint8_t KEY_A_FF[6] = {0xFF,0xFF,0xFF,0xFF,0xFF,0xFF};
uint8_t KEY_B_FF[6] = {0xFF,0xFF,0xFF,0xFF,0xFF,0xFF};

inline bool isTrailer(uint8_t block){ return (block % 4) == 3; }
inline bool isManufacturer(uint8_t block){ return block == 0; }
uint8_t nextDataBlock(uint8_t block){ uint8_t b = block + 1; if (isTrailer(b)) b++; return b; }

bool nthDataBlock(uint8_t startBlock, uint16_t n, uint8_t &outBlock){
  uint8_t b = startBlock;
  while (isManufacturer(b) || isTrailer(b)) { b = nextDataBlock(b); if (b > MAX_BLOCK) return false; }
  for (uint16_t i=0;i<n;i++){
    b = nextDataBlock(b);
    while (isManufacturer(b) || isTrailer(b)) { b = nextDataBlock(b); }
    if (b > MAX_BLOCK) return false;
  }
  outBlock = b; return true;
}

bool authWithAnyKey(uint8_t* uid, uint8_t uidLen, uint8_t block){
  if (nfc.mifareclassic_AuthenticateBlock(uid, uidLen, block, 0, KEY_A_FF)) return true;
  if (nfc.mifareclassic_AuthenticateBlock(uid, uidLen, block, 1, KEY_B_FF)) return true;
  return false;
}
bool readBlock(uint8_t block, uint8_t out16[16]) { return nfc.mifareclassic_ReadDataBlock(block, out16); }
bool writeBlock(uint8_t block, const uint8_t in16[16]) { return nfc.mifareclassic_WriteDataBlock(block, (uint8_t*)in16); }

uint16_t blocksUsedForLen(uint16_t payloadLen){
  uint32_t total = (uint32_t)payloadLen + 2;
  return (total + 15) / 16;
}


bool readEncodedLength(uint8_t* uid, uint8_t uidLen, uint8_t startBlock, uint16_t &outLen){
  uint8_t b = startBlock;
  while (isManufacturer(b) || isTrailer(b)) { b = nextDataBlock(b); if (b > MAX_BLOCK) return false; }
  if (!authWithAnyKey(uid, uidLen, b)) return false;
  uint8_t buf[16];
  if (!readBlock(b, buf)) return false;
  outLen = (uint16_t)buf[0] | ((uint16_t)buf[1] << 8);
  return true;
}


bool writeLongStringClassicWiping(uint8_t* uid, uint8_t uidLen, uint8_t startBlock,
                                  const uint8_t* data, uint16_t len){
  if (isManufacturer(startBlock) || isTrailer(startBlock)) {
    Serial.println(F("Start block invalid (manufacturer/trailer)."));
    return false;
  }
  uint16_t oldLen = 0; bool haveOldLen = readEncodedLength(uid, uidLen, startBlock, oldLen);
  uint16_t oldBlocks = haveOldLen ? blocksUsedForLen(oldLen) : 0;

  uint32_t bytesRemaining = 2 + len;
  uint32_t srcIndex = 0;
  uint8_t buf[16];
  uint16_t newBlocks = blocksUsedForLen(len);

  for (uint16_t blkIdx = 0; bytesRemaining > 0; blkIdx++) {
    uint8_t block;
    if (!nthDataBlock(startBlock, blkIdx, block) || block > MAX_BLOCK) {
      Serial.println(F("Out of allowed range during write."));
      return false;
    }
    if (!authWithAnyKey(uid, uidLen, block)) {
      Serial.print(F("Auth failed at block ")); Serial.println(block);
      return false;
    }

    memset(buf, 0x00, 16);
    for (uint8_t i = 0; i < 16 && bytesRemaining > 0; i++) {
      if (srcIndex < 2) {
        buf[i] = (srcIndex == 0) ? (uint8_t)(len & 0xFF) : (uint8_t)((len >> 8) & 0xFF);
        srcIndex++;
      } else {
        uint32_t payloadIndex = srcIndex - 2;
        buf[i] = (payloadIndex < len) ? data[payloadIndex] : 0x00;
        srcIndex++;
      }
      bytesRemaining--;
    }

    if (!writeBlock(block, buf)) {
      Serial.print(F("Write failed at block ")); Serial.println(block);
      return false;
    }
    // Serial.print(F("Wrote block ")); Serial.println(block);
  }

  if (oldBlocks > newBlocks) {
    Serial.print(F("Wiping leftover blocks: ")); Serial.print(oldBlocks - newBlocks); Serial.println(F(" block(s)"));
    uint8_t zeroes[16]; memset(zeroes, 0x00, 16);
    for (uint16_t blkIdx = newBlocks; blkIdx < oldBlocks; blkIdx++) {
      uint8_t block;
      if (!nthDataBlock(startBlock, blkIdx, block) || block > MAX_BLOCK) break;
      if (!authWithAnyKey(uid, uidLen, block)) {
        Serial.print(F("Auth failed during wipe at block ")); Serial.println(block);
        return false;
      }
      if (!writeBlock(block, zeroes)) {
        Serial.print(F("Wipe failed at block ")); Serial.println(block);
        return false;
      }
      // Serial.print(F("Wiped block ")); Serial.println(block);
    }
  }
  return true;
}


bool streamReadAsJsonClassic(uint8_t* uid, uint8_t uidLen){
  uint8_t firstBlock;
  if (!nthDataBlock(START_BLOCK, 0, firstBlock)) return false;
  if (!authWithAnyKey(uid, uidLen, firstBlock)) return false;

  uint8_t temp[16];
  if (!readBlock(firstBlock, temp)) return false;
  uint16_t total = (uint16_t)temp[0] | ((uint16_t)temp[1] << 8);

  Serial.print(F("{\"ok\":true,\"op\":\"read\",\"json\":\""));

  uint32_t remaining = total;
  uint8_t block = firstBlock;
  uint8_t i = 2;

  auto emitEscaped = [](char c){
    if (c=='\"') Serial.print(F("\\\""));
    else if (c=='\\') Serial.print(F("\\\\"));
    else if (c=='\n') Serial.print(F("\\n"));
    else if ((uint8_t)c < 0x20){ char u[7]; sprintf(u,"\\u%04X",(uint8_t)c); Serial.print(u); }
    else Serial.print(c);
  };

  while (remaining > 0){
    if (i >= 16){
      uint32_t consumed = (2 + (total - remaining));
      uint16_t blkIdx = consumed / 16;
      if (!nthDataBlock(START_BLOCK, blkIdx, block)) return false;
      if (!authWithAnyKey(uid, uidLen, block)) return false;
      if (!readBlock(block, temp)) return false;
      i = consumed % 16;
    }
    emitEscaped((char)temp[i++]);
    remaining--;
  }

  Serial.println(F("\"}"));
  return true;
}

bool waitForTag(uint8_t uid[], uint8_t &uidLen, uint32_t timeoutMs=15000){
  uint32_t t0=millis();
  while(millis()-t0 < timeoutMs){
    if (nfc.readPassiveTargetID(PN532_MIFARE_ISO14443A, uid, &uidLen, 150)){
      Serial.print(F("{\"evt\":\"tag\",\"uid\":\""));
      for(uint8_t i=0;i<uidLen;i++){ if(uid[i]<0x10) Serial.print('0'); Serial.print(uid[i],HEX); }
      Serial.println(F("\"}"));
      return true;
    }
    delay(30);
  }
  return false;
}


int hexVal(char c){
  if (c>='0' && c<='9') return c-'0';
  if (c>='A' && c<='F') return c-'A'+10;
  if (c>='a' && c<='f') return c-'a'+10;
  return -1;
}

int hexLenFromLine(const String& ln){
  if (!ln.startsWith(F("W:"))) return -1;
  return (int)ln.length() - 2; // 'W:' 제외
}


bool writeHexLineToTagStreaming(const String& ln){
  int hlen = hexLenFromLine(ln);
  if (hlen <= 0 || (hlen % 2) != 0) return false;
  uint16_t payloadLen = (uint16_t)(hlen/2);

  uint8_t uid[7]; uint8_t uidLen=0;
  if(!waitForTag(uid, uidLen)) return false;

  // 이전 길이/블록 수 확인 (와이프를 위해)
  uint16_t oldLen = 0; bool haveOldLen = readEncodedLength(uid, uidLen, START_BLOCK, oldLen);
  uint16_t oldBlocks = haveOldLen ? blocksUsedForLen(oldLen) : 0;

  // 쓰기 루프: 헤더(2B) + 본문(payloadLen)
  uint32_t totalBytes = 2 + payloadLen;
  uint32_t produced = 0;
  uint16_t newBlocks = blocksUsedForLen(payloadLen);

  uint16_t blkIdx = 0;
  uint8_t block;
  uint8_t buf[16]; uint8_t bi=0;

  auto flushBlock = [&]()->bool{
    if (!nthDataBlock(START_BLOCK, blkIdx, block) || block > MAX_BLOCK) return false;
    if (!authWithAnyKey(uid, uidLen, block)) return false;
    bool ok = writeBlock(block, buf);
    // if (ok){ Serial.print(F("Wrote block ")); Serial.println(block); }
    blkIdx++; bi=0; return ok;
  };

  auto pushByte = [&](uint8_t b)->bool{
    buf[bi++] = b; produced++;
    if (bi==16 || produced==totalBytes){
      while (bi<16) buf[bi++]=0x00; // 패딩 0
      if (!flushBlock()) return false;
    }
    return true;
  };


  memset(buf,0,16); bi=0;
  if (!pushByte((uint8_t)(payloadLen & 0xFF))) return false;
  if (!pushByte((uint8_t)((payloadLen>>8) & 0xFF))) return false;

  for (int i=2; i<ln.length(); i+=2){
    int hi = hexVal(ln[i]); int lo = hexVal(ln[i+1]);
    if (hi<0 || lo<0) return false;
    if (!pushByte((uint8_t)((hi<<4)|lo))) return false;
  }


  if (oldBlocks > newBlocks){
    Serial.print(F("Wiping leftover blocks: ")); Serial.print(oldBlocks - newBlocks); Serial.println(F(" block(s)"));
    uint8_t zeroes[16]; memset(zeroes, 0x00, 16);
    for (uint16_t i=newBlocks; i<oldBlocks; i++){
      if (!nthDataBlock(START_BLOCK, i, block) || block > MAX_BLOCK) break;
      if (!authWithAnyKey(uid, uidLen, block)) return false;
      if (!writeBlock(block, zeroes)) return false;
      // Serial.print(F("Wiped block ")); Serial.println(block);
    }
  }
  return true;
}

void handleSerialBridge(){
  if(!Serial.available()) return;
  String ln = Serial.readStringUntil('\n'); ln.trim();
  if(ln.length()==0) return;

  if (ln=="R"){
    // Serial.println(F("{\"info\":\"waiting_for_tag\"}"));
    uint8_t uid[7]; uint8_t uidLen=0;
    if(!waitForTag(uid, uidLen)){
      Serial.println(F("{\"ok\":false,\"op\":\"read\",\"error\":\"timeout\"}"));
      return;
    }
    if (!streamReadAsJsonClassic(uid, uidLen)){
      Serial.println(F("{\"ok\":false,\"op\":\"read\",\"error\":\"read fail\"}"));
    }
  }
  else if (ln.startsWith(F("W:"))){
    // Serial.println(F("{\"info\":\"waiting_for_tag\"}"));
    if (writeHexLineToTagStreaming(ln)){
      Serial.println(F("{\"ok\":true,\"op\":\"write\",\"info\":\"written\"}"));
    } else {
      Serial.println(F("{\"ok\":false,\"op\":\"write\",\"error\":\"write fail\"}"));
    }
  }
}
void sendModeCode() {
  if (currentMode == MODE_READ) {
    Serial.println(F("0"));
  } else {
    Serial.println(F("1"));
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(PIN_MODE_BTN, INPUT_PULLUP);
  pinMode(PIN_EXEC_BTN, INPUT_PULLUP);

  Wire.begin();
  nfc.begin();
  uint32_t v = nfc.getFirmwareVersion();
  if (!v) {
    Serial.println(F("PN532 not found. Check wiring/jumpers."));
    while (1);
  }
  nfc.SAMConfig();
  Serial.println(F("Ready. Type 'w'/'r' or use 'R'/'W:<HEX>' over serial."));


  sendModeCode();
}

void scanButtons() {
  // D7 (모드)
  bool rawM = digitalRead(PIN_MODE_BTN);
  if (rawM != modeReading) { modeReading = rawM; modeChangedAt = millis(); }
  if ((millis() - modeChangedAt) > DEBOUNCE_MS && modeStable != modeReading) {
    modeStable = modeReading;
    if (modeStable == LOW) {

      currentMode = (currentMode == MODE_READ) ? MODE_WRITE : MODE_READ;
      sendModeCode();
    }
  }

  // D8 (실행)
  bool rawE = digitalRead(PIN_EXEC_BTN);
  if (rawE != execReading) { execReading = rawE; execChangedAt = millis(); }
  if ((millis() - execChangedAt) > DEBOUNCE_MS && execStable != execReading) {
    execStable = execReading;
    if (execStable == LOW) {
      Serial.println(F("2"));
      // if (currentMode == MODE_READ) {
      //   Serial.println(F("2"));
      // } else {
      //   Serial.println(F("3"));
      // }
    }
  }
}

void loop() {
  scanButtons();
  handleSerialBridge();


}