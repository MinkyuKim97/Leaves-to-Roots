# Leaves-to-Roots
[Converting data as a physical form]

[![Process Explain Video](https://youtu.be/4VgSv-UemZQ?si=nowoPiBr-Boq7f3_)](https://youtu.be/4VgSv-UemZQ?si=nowoPiBr-Boq7f3_)


## How to set up
1. 'script.js': Line 1, 'const USER_ID' - Set it as your facebook user Id from [Facebook -> setting -> activity Log -> Comments]
2. Connect with Arduino: with PN532 and 2 button (pin info in .ino file)
3. Open Websocket via Python: Terminal -> Type 'python3 wsBridge.py'. It will automatically detect the Arduino serial port
4. Enter 'index.html' or page link
5. Prepare your facebook comment data vit personal data download. Only 'comments.json' file required.

## How to use
1. Index.html: Press 'Connect' button on the left side console window (Default is Port 8080)
2. Import 'commetns.json' through pressing choose file button
3. Presee the left button on arduino module to control the read/write states, and press right button to execute the mode.
4. Look through the comments infomation on the top div, and select which want to remove and store.
5. Set the mode as 'write' and execute it. Adn tag NFC card to store it.
6. Now the comment data is stored in NFC card, go to right side console at index.html and press 'To Facebook'. It will automatically set the date range, so user can find the comment easily.
7. 'Ctrl + F' and 'Ctrl + V' to paste the comment data from the clipboard. In a previous stage, JS automatically copy the comment data.
8. Decide delete the comment or not
9. Back to index.html. Turn into a read mode vit Arduino. Execute it with the right side button.
10. Tag NFC card which you stored the data, you will see the stored data on teh bottom div.

