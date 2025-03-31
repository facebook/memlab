

### Purpose and Core Functionality
This project is a specialized production memory diagnostic collection and local dev debugging tool designed to detect and visualize memory leaks in React applications, with a particular focus on identifying detached components that should have been garbage collected but remain in memory.

### How It Works

#### Detection System
The module operates through multiple layers of monitoring:
 * **DOM Scanning**: Continuously scans the Document Object Model to create a comprehensive map of all elements present in the application.
 * **React Fiber Analysis**: Specifically tracks React's internal fiber tree structure, which represents the component hierarchy and their relationships.
 * **Memory Leak Detection**: Identifies components that are no longer attached to the main DOM tree but still persist in memory, indicating potential memory leaks.

#### Monitoring Process
The system employs a dual-monitoring approach:
 * **Periodic Scanning**: Runs regular scans at configurable intervals to check for detached components.
 * **Real-time Observation**: Uses mutation observers to detect DOM changes as they happen, ensuring immediate detection of potential issues.

#### Visualization System
The visualization component provides real-time feedback through:
 * **Overlay Layer**: Creates a transparent canvas overlay that sits above the application.
 * **Visual Indicators**: Draws highlighting boxes around problematic components.
 * **Component Information**: Displays relevant information about detected issues, including component names and their locations.

### Key Features

#### Memory Safety
- Implements memory-safe tracking mechanisms using weak references
- Avoids creating memory leaks while detecting them
- Ensures the debugging tool itself doesn't impact application performance

#### Non-Intrusive Design
- Operates without interfering with the application's normal functionality
- Uses a transparent overlay that doesn't block user interactions
- Can be easily enabled or disabled as needed

#### Developer Tools Integration
- Provides detailed debugging information in development mode
- Offers subscription capabilities for external monitoring tools
- Maintains detailed statistics about detected issues

### Use Cases

 * **Production Performance Monitoring**
   - Monitoring application memory usage patterns
   - Detecting gradual memory leaks in long-running applications
   - Identifying patterns in component detachment

 * **Development Debugging**
   - Identifying component cleanup issues during development
   - Tracking down memory leaks in complex component hierarchies
   - Visualizing component lifecycle issues

This tool serves as an essential debugging aid for React developers, helping them maintain efficient and leak-free applications while providing valuable insights into component behavior and memory management patterns.
