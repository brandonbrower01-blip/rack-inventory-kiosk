// Kinds of equipment tracked one by one (label printers, laptops / desktops).
// Shared by the server (require) and the page (<script>), so fields and wording stay in step.
(function (root) {
  'use strict';
  const KINDS = {
    printer: {
      key: 'printer',
      view: 'repairs',              // URL hash for the tab (kept from the first version)
      tab: 'Printer Inventory',
      label: 'printer', Label: 'Printer', plural: 'printers',
      prefix: 'PR-', numPrefix: '2', // barcode 2xxxxx = PR-xxxx
      files: { list: 'printers.json', repairs: 'repairs.json', log: 'printer-history.jsonl' },
      api: { list: '/api/printers', repairs: '/api/repairs', history: '/api/printer-history',
        repairsCsv: '/api/export/repairs.csv', historyCsv: '/api/export/printer-history.csv', csvName: 'printer' },
      idField: 'printerId', nameField: 'printerName', removedField: 'printerRemoved',
      emptyTitle: 'No label printers yet',
      emptyText: 'Add each label printer once, then log every repair against it: what was fixed, when, by whom and what it cost.',
      fields: [
        { key: 'name', label: 'Name', required: true, max: 80, placeholder: 'e.g. Shipping desk printer' },
        { key: 'model', label: 'Make and model', hist: 'Model', max: 80, placeholder: 'e.g. Zebra ZD421',
          suggest: ['Dymo LabelWriter 450', 'Dymo LabelWriter 550', 'Dymo LabelWriter 5XL', 'Brother QL-800', 'Brother QL-820NWB',
            'Brother QL-1110NWB', 'Zebra ZD421', 'Zebra ZD621', 'Zebra GK420d', 'Zebra ZT230', 'Rollo Wireless', 'Munbyn ITPP941'] },
        { key: 'serial', label: 'Serial number', max: 80, placeholder: 'On the sticker underneath' },
        { key: 'location', label: 'Where it is', hist: 'Location', max: 80, placeholder: 'e.g. Rack room, bench 2' },
        { key: 'notes', label: 'Notes (optional)', hist: 'Notes', max: 1000, type: 'textarea', placeholder: 'Purchase date, warranty, label size it uses…' },
      ],
      repairTypes: ['Printhead cleaned', 'Printhead replaced', 'Platen roller cleaned', 'Platen roller replaced', 'Label jam cleared',
        'Cutter repaired or replaced', 'Sensor cleaned or calibrated', 'Firmware updated', 'Driver reinstalled', 'Power supply replaced',
        'Cable or port repaired', 'Feed mechanism repaired', 'Case or door repaired', 'Other'],
      repairPlaceholder: 'e.g. Faded print on left side. Replaced printhead, ran calibration.',
    },
    computer: {
      key: 'computer',
      view: 'computers',
      tab: 'Laptops / Desktops',
      tapeIn: 0.7,                  // labels print on 0.7 in wide tape; the length fits the text
      label: 'computer', Label: 'Computer', plural: 'computers',
      prefix: 'PC-', numPrefix: '3', // barcode 3xxxxx = PC-xxxx
      files: { list: 'computers.json', repairs: 'computer-repairs.json', log: 'computer-history.jsonl' },
      api: { list: '/api/computers', repairs: '/api/computer-repairs', history: '/api/computer-history',
        repairsCsv: '/api/export/computer-repairs.csv', historyCsv: '/api/export/computer-history.csv', csvName: 'computer' },
      idField: 'computerId', nameField: 'computerName', removedField: 'computerRemoved',
      emptyTitle: 'No laptops or desktops yet',
      emptyText: 'Add each laptop and desktop once, then track who has it, where it is, and every repair: what was fixed, when, by whom and what it cost.',
      fields: [
        { key: 'name', label: 'Name', required: true, max: 80, placeholder: 'e.g. Front desk laptop' },
        { key: 'type', label: 'Type', type: 'select', options: ['Laptop', 'Desktop', 'All-in-one', 'Other'], default: 'Laptop', filter: true },
        { key: 'status', label: 'Status', type: 'select', options: ['In use', 'Spare', 'In repair', 'Retired'], default: 'In use', filter: true },
        { key: 'model', label: 'Make and model', hist: 'Model', max: 80, placeholder: 'e.g. Dell Latitude 5440',
          suggest: ['Dell Latitude 5440', 'Dell Latitude 7450', 'Dell OptiPlex 7010', 'HP EliteBook 840', 'HP ProBook 450', 'HP ProDesk 400',
            'Lenovo ThinkPad T14', 'Lenovo ThinkPad X1 Carbon', 'Lenovo ThinkCentre M70q', 'Apple MacBook Air', 'Apple MacBook Pro', 'Apple iMac',
            'Microsoft Surface Laptop'] },
        { key: 'serial', label: 'Serial number / service tag', hist: 'Serial number', max: 80, placeholder: 'On the bottom or in the BIOS' },
        { key: 'assetTag', label: 'Asset tag', max: 80, placeholder: 'Optional' },
        { key: 'hostname', label: 'Computer name (hostname)', hist: 'Computer name', max: 80, placeholder: 'e.g. FRONTDESK-01' },
        { key: 'os', label: 'Operating system', max: 80, placeholder: 'e.g. Windows 11',
          suggest: ['Windows 11', 'Windows 10', 'macOS', 'Linux', 'ChromeOS'] },
        { key: 'assignedTo', label: 'Assigned to', max: 80, placeholder: 'Who uses it (leave blank if spare)' },
        { key: 'location', label: 'Where it is', hist: 'Location', max: 80, placeholder: 'e.g. Front office' },
        { key: 'purchaseDate', label: 'Purchase date', type: 'date' },
        { key: 'warrantyEnd', label: 'Warranty ends', type: 'date' },
        { key: 'notes', label: 'Notes (optional)', hist: 'Notes', max: 1000, type: 'textarea', placeholder: 'Specs, accessories, licence keys location…' },
      ],
      repairTypes: ['Hard drive or SSD replaced', 'RAM added or replaced', 'Battery replaced', 'Screen replaced', 'Keyboard or trackpad replaced',
        'Charger or power supply replaced', 'Reimaged / OS reinstalled', 'Software installed or updated', 'Virus or malware removed',
        'Fan or cooling cleaned', 'Motherboard repaired', 'Data recovered', 'Other'],
      repairPlaceholder: 'e.g. Wouldn’t boot. Replaced SSD and reimaged with Windows 11.',
    },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = KINDS;
  else root.ASSET_KINDS = KINDS;
})(this);
